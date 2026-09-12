//! shdoc/1 HTML 코덱 — 형식 감지, 파싱, 자원 lock, canonical 재직렬화 (v2 설계 §5, §7).
//!
//! 파서는 html5ever 문 트리 구성을 그대로 사용한다. 이 저장소의 의존성 사정으로
//! `markup5ever_rcdom`(markup5ever 0.39 기반)은 `html5ever` 0.40의 `TreeSink`와
//! 타입이 맞지 않아 직접 쓸 수 없어서, 아래 `dom` 모듈이 같은 계약을 가진 최소
//! Rc DOM으로 트리 싱크를 구현한다. 모든 직렬화·탐색은 깊은 중첩에서도 스택이
//! 넘치지 않게 반복문으로 처리한다.

use std::borrow::Cow;
use std::cell::{Cell, RefCell};
use std::collections::HashSet;
use std::mem;
use std::rc::Rc;

use html5ever::driver::{parse_document, ParseOpts};
use html5ever::interface::tree_builder::{ElementFlags, NodeOrText, QuirksMode, TreeSink};
use html5ever::tendril::{StrTendril, TendrilSink};
use html5ever::{Attribute, ExpandedName, QualName};
use sha2::{Digest, Sha256};

use super::model::{ResourceLock, ShdocBlock, ShdocDocument, SHDOC_FORMAT_VERSION};

/// 문서 원문 크기 상한. sdlc.rs의 Markdown 문서 한도와 같은 정신이다.
pub const SHDOC_MAX_BYTES: usize = 4 * 1024 * 1024;

const HTML_NAMESPACE: &str = "http://www.w3.org/1999/xhtml";

/// 텍스트 입력의 형식 판별 결과.
/// 검색 수집기(R2)가 .md/.html 수집 분기에 사용한다.
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DocumentFormat {
    /// `sawhorse:format` 메타가 `shdoc/1`인 HTML 원본 문서.
    NativeHtml,
    /// 기존 YAML frontmatter + Markdown 문서(`LegacyMarkdownCodec` 대상).
    LegacyMarkdown,
}

/// 텍스트의 `sawhorse:format` 메타로 형식을 감지한다. 값 비교는 대소문자를
/// 무시하고, 메타가 없거나 값이 다르면 Markdown으로 분류한다.
#[allow(dead_code)] // R2: 검색·스캔 수집기가 소비한다.
pub fn detect_format(text: &str) -> DocumentFormat {
    let dom = parse_dom(text);
    match head_meta(&dom, "sawhorse:format") {
        Some(value) if value.eq_ignore_ascii_case(SHDOC_FORMAT_VERSION) => {
            DocumentFormat::NativeHtml
        }
        _ => DocumentFormat::LegacyMarkdown,
    }
}

/// shdoc/1 HTML 원문을 파싱해 문서 구조를 만든다.
///
/// 구조 계약(head 메타, canonical `article#document`)을 만족하지 않으면 실패한다.
/// 값 계약(document-id 누락 등)은 여기서 거부하지 않고 [`super::validation`]이
/// 판정한다.
pub fn parse_native_html(text: &str) -> Result<ShdocDocument, String> {
    if text.len() > SHDOC_MAX_BYTES {
        return Err("문서는 4 MiB를 넘을 수 없습니다".into());
    }
    let dom = parse_dom(text);

    let html_element = first_element_child(&dom.document, "html")
        .ok_or_else(|| "html 요소를 찾을 수 없습니다".to_string())?;
    let lang = attr_value(&html_element, "lang").filter(|v| !v.is_empty());

    let head = first_element_child(&html_element, "head");
    let format_meta = head
        .as_ref()
        .and_then(|h| head_meta_in(h, "sawhorse:format"));
    match format_meta {
        Some(value) if value.eq_ignore_ascii_case(SHDOC_FORMAT_VERSION) => {}
        _ => return Err("sawhorse:format 메타가 없거나 shdoc/1이 아닙니다".into()),
    }
    let document_id = head
        .as_ref()
        .and_then(|h| head_meta_in(h, "sawhorse:document-id"))
        .unwrap_or_default();
    let profile = head
        .as_ref()
        .and_then(|h| head_meta_in(h, "sawhorse:document-profile"))
        .filter(|v| !v.is_empty());
    let title = head
        .as_ref()
        .and_then(|h| find_first_element(h, "title"))
        .map(|t| text_content(&t))
        .unwrap_or_default();

    let article = find_canonical_article(&dom)
        .ok_or_else(|| "canonical 문서 요소(article#document)를 찾을 수 없습니다".to_string())?;
    let blocks = element_children(&article)
        .into_iter()
        .filter_map(|child| {
            let block_id = attr_value(&child, "id").filter(|v| !v.is_empty())?;
            let kind = attr_value(&child, "data-sh-kind").filter(|v| !v.is_empty());
            let mut html = String::new();
            serialize_element_into(&child, &mut html);
            Some(ShdocBlock {
                block_id,
                kind,
                html,
            })
        })
        .collect();

    Ok(ShdocDocument {
        format_version: SHDOC_FORMAT_VERSION.to_string(),
        document_id,
        profile,
        lang,
        title,
        blocks,
    })
}

/// 문서가 참조하는 자산(`img src`, `data-sh-ref`)을 블록·속성 등장 순서로 수집해
/// 중복을 제거한 자원 lock을 만든다.
#[allow(dead_code)] // R3: candidate 저장이 resource_lock 기록에 사용한다.
pub fn extract_resource_lock(doc: &ShdocDocument) -> ResourceLock {
    let mut assets: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for block in &doc.blocks {
        // 블록은 문서 문맥의 직렬화 조각이라 body 컨텍스트로 다시 파싱해도
        // 구조가 같다. 자원 참조만 보면 되므로 body 서브트리를 전부 훑는다.
        let wrapped = format!("<body>{}</body>", block.html);
        let dom = parse_dom(&wrapped);
        let body = first_element_child(&dom.document, "html")
            .and_then(|html| first_element_child(&html, "body"));
        let Some(body) = body else { continue };
        walk_elements(&body, &mut |element| {
            let img = is_html_element(element, "img");
            for (name, value) in element_attrs(element) {
                let is_reference = (img && name == "src") || name == "data-sh-ref";
                if is_reference && !value.is_empty() && seen.insert(value.clone()) {
                    assets.push(value);
                }
            }
        });
    }
    ResourceLock { assets }
}

/// 문서를 안정적인 canonical HTML(doctype + html + head 메타 + body)로 재직렬화한다.
/// 같은 [`ShdocDocument`]에서는 항상 같은 bytes가 나온다.
#[allow(dead_code)] // R2·R3: 읽기 화면 정규 표시·구조 diff가 사용한다.
pub fn canonical_html(doc: &ShdocDocument) -> String {
    let mut out = String::new();
    out.push_str("<!doctype html>\n");
    match doc.lang.as_deref().filter(|l| !l.is_empty()) {
        Some(lang) => {
            out.push_str("<html lang=\"");
            escape_attr_into(lang, &mut out);
            out.push_str("\">\n");
        }
        None => out.push_str("<html>\n"),
    }
    out.push_str("<head>\n");
    out.push_str("<meta charset=\"utf-8\">\n");
    out.push_str("<meta name=\"sawhorse:format\" content=\"");
    escape_attr_into(SHDOC_FORMAT_VERSION, &mut out);
    out.push_str("\">\n");
    if !doc.document_id.is_empty() {
        out.push_str("<meta name=\"sawhorse:document-id\" content=\"");
        escape_attr_into(&doc.document_id, &mut out);
        out.push_str("\">\n");
    }
    if let Some(profile) = doc.profile.as_deref().filter(|p| !p.is_empty()) {
        out.push_str("<meta name=\"sawhorse:document-profile\" content=\"");
        escape_attr_into(profile, &mut out);
        out.push_str("\">\n");
    }
    out.push_str("<title>");
    escape_text_into(&doc.title, &mut out);
    out.push_str("</title>\n</head>\n<body>\n<main>\n<article id=\"document\">\n");
    for block in &doc.blocks {
        out.push_str(&block.html);
        out.push('\n');
    }
    out.push_str("</article>\n</main>\n</body>\n</html>\n");
    out
}

/// 원문 bytes의 SHA-256 hex digest. CAS 저장·복구·원본 출처 식별에 쓴다.
pub fn source_digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

// ---------------------------------------------------------------------------
// DOM — html5ever TreeSink를 만족하는 최소 Rc 트리.
// markup5ever_rcdom(0.39, markup5ever 0.39 기반)은 html5ever 0.40의 TreeSink
// 타입과 맞지 않아 같은 구조를 여기에 둔다. TreeSink 계약상 필요하지만 shdoc
// 읽기 경로에서 읽지 않는 필드(quirks_mode 등)도 파서가 요구하는 대로 유지한다.
// ---------------------------------------------------------------------------

mod dom {
    use super::{
        mem, Attribute, Cell, Cow, ElementFlags, ExpandedName, HashSet, NodeOrText, QualName,
        QuirksMode, Rc, RefCell, StrTendril, TreeSink,
    };

    /// DOM 노드의 종류. `TreeSink` 계약상 요구되는 필드(name·public_id·system_id·
    /// target 등) 중 일부는 이 파서가 읽지 않는다.
    #[allow(dead_code)]
    pub(crate) enum NodeData {
        Document,
        Doctype {
            name: StrTendril,
            public_id: StrTendril,
            system_id: StrTendril,
        },
        Text {
            contents: RefCell<StrTendril>,
        },
        Comment {
            contents: StrTendril,
        },
        Element {
            name: QualName,
            attrs: RefCell<Vec<Attribute>>,
            template_contents: RefCell<Option<Handle>>,
            mathml_annotation_xml_integration_point: bool,
        },
        ProcessingInstruction {
            target: StrTendril,
            contents: StrTendril,
        },
    }

    /// DOM 노드. 자식 목록과 부모(weak) 포인터를 가진다.
    pub(crate) struct Node {
        pub parent: Cell<Option<WeakHandle>>,
        pub children: RefCell<Vec<Handle>>,
        pub data: NodeData,
    }

    pub(crate) type Handle = Rc<Node>;
    pub(crate) type WeakHandle = super::WeakHandle;

    impl Node {
        fn new(data: NodeData) -> Handle {
            Rc::new(Node {
                data,
                parent: Cell::new(None),
                children: RefCell::new(Vec::new()),
            })
        }
    }

    // 깊은 중첩 문서에서 재귀 드롭으로 스택이 넘치지 않게 자식을 반복문으로 정리한다.
    impl Drop for Node {
        fn drop(&mut self) {
            let mut nodes = mem::take(&mut *self.children.borrow_mut());
            while let Some(node) = nodes.pop() {
                let children = mem::take(&mut *node.children.borrow_mut());
                nodes.extend(children.into_iter());
                if let NodeData::Element {
                    ref template_contents,
                    ..
                } = node.data
                {
                    if let Some(template_contents) = template_contents.borrow_mut().take() {
                        nodes.push(template_contents);
                    }
                }
            }
        }
    }

    /// 파싱 결과 DOM. 문서 루트와 진단 정보를 담는다.
    pub(crate) struct Dom {
        pub document: Handle,
        pub errors: RefCell<Vec<String>>,
        pub quirks_mode: Cell<QuirksMode>,
    }

    impl Default for Dom {
        fn default() -> Dom {
            Dom {
                document: Node::new(NodeData::Document),
                errors: RefCell::new(Vec::new()),
                quirks_mode: Cell::new(QuirksMode::NoQuirks),
            }
        }
    }

    fn append(new_parent: &Handle, child: Handle) {
        let previous_parent = child.parent.replace(Some(Rc::downgrade(new_parent)));
        // 트리 빌더 계약: 이미 부모가 있는 노드는 append 대상이 아니다.
        assert!(previous_parent.is_none());
        new_parent.children.borrow_mut().push(child);
    }

    fn get_parent_and_index(target: &Handle) -> Option<(Handle, usize)> {
        if let Some(weak) = target.parent.take() {
            let parent = weak.upgrade().expect("매달린 weak 포인터");
            target.parent.set(Some(weak));
            let index = parent
                .children
                .borrow()
                .iter()
                .enumerate()
                .find(|&(_, child)| Rc::ptr_eq(child, target))
                .map(|(i, _)| i)
                .unwrap_or_else(|| panic!("부모는 있지만 자식 목록에서 노드를 찾지 못했습니다"));
            Some((parent, index))
        } else {
            None
        }
    }

    fn append_to_existing_text(prev: &Handle, text: &str) -> bool {
        match prev.data {
            NodeData::Text { ref contents } => {
                contents.borrow_mut().push_slice(text);
                true
            }
            _ => false,
        }
    }

    fn detach(target: &Handle) {
        if let Some((parent, i)) = get_parent_and_index(target) {
            parent.children.borrow_mut().remove(i);
            target.parent.set(None);
        }
    }

    impl TreeSink for Dom {
        type Output = Self;
        type Handle = Handle;
        type ElemName<'a>
            = ExpandedName<'a>
        where
            Self: 'a;

        fn finish(self) -> Self {
            self
        }

        fn parse_error(&self, msg: Cow<'static, str>) {
            self.errors.borrow_mut().push(msg.into_owned());
        }

        fn get_document(&self) -> Handle {
            self.document.clone()
        }

        fn get_template_contents(&self, target: &Handle) -> Handle {
            if let NodeData::Element {
                ref template_contents,
                ..
            } = target.data
            {
                template_contents
                    .borrow()
                    .as_ref()
                    .expect("template 요소가 아닙니다")
                    .clone()
            } else {
                panic!("template 요소가 아닙니다")
            }
        }

        fn set_quirks_mode(&self, mode: QuirksMode) {
            self.quirks_mode.set(mode);
        }

        fn same_node(&self, x: &Handle, y: &Handle) -> bool {
            Rc::ptr_eq(x, y)
        }

        fn elem_name<'a>(&self, target: &'a Handle) -> ExpandedName<'a> {
            match target.data {
                NodeData::Element { ref name, .. } => name.expanded(),
                _ => panic!("요소 노드가 아닙니다"),
            }
        }

        fn create_element(
            &self,
            name: QualName,
            attrs: Vec<Attribute>,
            flags: ElementFlags,
        ) -> Handle {
            Node::new(NodeData::Element {
                name,
                attrs: RefCell::new(attrs),
                template_contents: RefCell::new(if flags.template {
                    Some(Node::new(NodeData::Document))
                } else {
                    None
                }),
                mathml_annotation_xml_integration_point: flags
                    .mathml_annotation_xml_integration_point,
            })
        }

        fn create_comment(&self, text: StrTendril) -> Handle {
            Node::new(NodeData::Comment { contents: text })
        }

        fn create_pi(&self, target: StrTendril, data: StrTendril) -> Handle {
            Node::new(NodeData::ProcessingInstruction {
                target,
                contents: data,
            })
        }

        fn append(&self, parent: &Handle, child: NodeOrText<Handle>) {
            if let NodeOrText::AppendText(text) = &child {
                if let Some(last) = parent.children.borrow().last() {
                    if append_to_existing_text(last, text) {
                        return;
                    }
                }
            }
            append(
                parent,
                match child {
                    NodeOrText::AppendText(text) => Node::new(NodeData::Text {
                        contents: RefCell::new(text),
                    }),
                    NodeOrText::AppendNode(node) => node,
                },
            );
        }

        fn append_before_sibling(&self, sibling: &Handle, child: NodeOrText<Handle>) {
            let (parent, i) =
                get_parent_and_index(sibling).expect("부모가 없는 노드 앞에 삽입할 수 없습니다");
            let child = match (child, i) {
                (NodeOrText::AppendText(text), 0) => Node::new(NodeData::Text {
                    contents: RefCell::new(text),
                }),
                (NodeOrText::AppendText(text), i) => {
                    let children = parent.children.borrow();
                    let prev = &children[i - 1];
                    if append_to_existing_text(prev, &text) {
                        return;
                    }
                    Node::new(NodeData::Text {
                        contents: RefCell::new(text),
                    })
                }
                // 트리 빌더 계약상 삽입점 뒤에 텍스트 노드는 오지 않는다.
                (NodeOrText::AppendNode(node), _) => node,
            };
            detach(&child);
            child.parent.set(Some(Rc::downgrade(&parent)));
            parent.children.borrow_mut().insert(i, child);
        }

        fn append_based_on_parent_node(
            &self,
            element: &Handle,
            prev_element: &Handle,
            child: NodeOrText<Handle>,
        ) {
            let parent = element.parent.take();
            let has_parent = parent.is_some();
            element.parent.set(parent);
            if has_parent {
                self.append_before_sibling(element, child);
            } else {
                self.append(prev_element, child);
            }
        }

        fn append_doctype_to_document(
            &self,
            name: StrTendril,
            public_id: StrTendril,
            system_id: StrTendril,
        ) {
            append(
                &self.document,
                Node::new(NodeData::Doctype {
                    name,
                    public_id,
                    system_id,
                }),
            );
        }

        fn add_attrs_if_missing(&self, target: &Handle, attrs: Vec<Attribute>) {
            let mut existing = if let NodeData::Element { ref attrs, .. } = target.data {
                attrs.borrow_mut()
            } else {
                panic!("요소 노드가 아닙니다")
            };
            let existing_names = existing
                .iter()
                .map(|e| e.name.clone())
                .collect::<HashSet<_>>();
            existing.extend(
                attrs
                    .into_iter()
                    .filter(|attr| !existing_names.contains(&attr.name)),
            );
        }

        fn remove_from_parent(&self, target: &Handle) {
            detach(target);
        }

        fn reparent_children(&self, node: &Handle, new_parent: &Handle) {
            let mut children = node.children.borrow_mut();
            let mut new_children = new_parent.children.borrow_mut();
            for child in children.iter() {
                let previous_parent = child.parent.replace(Some(Rc::downgrade(new_parent)));
                assert!(Rc::ptr_eq(
                    node,
                    &previous_parent
                        .unwrap()
                        .upgrade()
                        .expect("매달린 weak 포인터")
                ));
            }
            new_children.extend(mem::take(&mut *children));
        }

        fn is_mathml_annotation_xml_integration_point(&self, target: &Handle) -> bool {
            if let NodeData::Element {
                mathml_annotation_xml_integration_point,
                ..
            } = target.data
            {
                mathml_annotation_xml_integration_point
            } else {
                panic!("요소 노드가 아닙니다")
            }
        }
    }
}

use dom::{Dom, Handle, NodeData};
type WeakHandle = std::rc::Weak<dom::Node>;

// ---------------------------------------------------------------------------
// 파싱·탐색 헬퍼 — validation.rs도 같은 경로로 신뢰할 수 없는 원문을 재파싱한다.
// ---------------------------------------------------------------------------

/// 텍스트를 문서로 파싱한다. 선행 UTF-8 BOM은 관용적으로 제거한다.
pub(crate) fn parse_dom(text: &str) -> Dom {
    let text = text.strip_prefix('\u{FEFF}').unwrap_or(text);
    parse_document(Dom::default(), ParseOpts::default()).one(text)
}

/// `parent`의 직계 자식 중 요소 노드만 반환한다.
pub(crate) fn element_children(parent: &Handle) -> Vec<Handle> {
    parent
        .children
        .borrow()
        .iter()
        .filter(|child| matches!(child.data, NodeData::Element { .. }))
        .cloned()
        .collect()
}

/// 자식 노드 전체(요소·텍스트·주석)를 순서대로 복사한다. 직렬화 순회용.
fn child_nodes(parent: &Handle) -> Vec<Handle> {
    parent.children.borrow().clone()
}

/// 트리 순서로 `root` 이하의 모든 요소를 방문한다(반복문 구현, 깊이 제한 없음).
pub(crate) fn walk_elements(root: &Handle, visit: &mut dyn FnMut(&Handle)) {
    let mut stack = vec![root.clone()];
    while let Some(node) = stack.pop() {
        if matches!(node.data, NodeData::Element { .. }) {
            visit(&node);
        }
        let children = node.children.borrow().clone();
        for child in children.iter().rev() {
            stack.push(child.clone());
        }
    }
}

/// html 네임스페이스 요소의 로컬 이름. 다른 종류 노드는 `None`이다.
pub(crate) fn element_local_name(node: &Handle) -> Option<String> {
    match &node.data {
        NodeData::Element { name, .. } if &*name.ns == HTML_NAMESPACE => {
            Some(name.local.to_string())
        }
        _ => None,
    }
}

/// 노드가 html 네임스페이스의 지정 요소인지 확인한다.
pub(crate) fn is_html_element(node: &Handle, local: &str) -> bool {
    element_local_name(node).as_deref() == Some(local)
}

/// 요소의 속성 값을 로컬 이름으로 찾는다.
pub(crate) fn attr_value(node: &Handle, local: &str) -> Option<String> {
    match &node.data {
        NodeData::Element { attrs, .. } => attrs
            .borrow()
            .iter()
            .find(|attr| &*attr.name.local == local)
            .map(|attr| attr.value.to_string()),
        _ => None,
    }
}

/// 요소의 속성을 (정규화된 이름, 값) 목록으로 원문 순서 그대로 복사한다.
pub(crate) fn element_attrs(node: &Handle) -> Vec<(String, String)> {
    match &node.data {
        NodeData::Element { attrs, .. } => attrs
            .borrow()
            .iter()
            .map(|attr| (qualified(&attr.name), attr.value.to_string()))
            .collect(),
        _ => Vec::new(),
    }
}

/// 자손 텍스트를 트리 순서로 모은다.
pub(crate) fn text_content(root: &Handle) -> String {
    let mut out = String::new();
    let mut stack = vec![root.clone()];
    while let Some(node) = stack.pop() {
        if let NodeData::Text { contents } = &node.data {
            out.push_str(&contents.borrow());
        }
        let children = node.children.borrow().clone();
        for child in children.iter().rev() {
            stack.push(child.clone());
        }
    }
    out
}

/// 요소 중첩 깊이의 최댓값을 계산한다(루트는 깊이 1).
pub(crate) fn max_element_depth(root: &Handle) -> usize {
    let mut max_depth = 0usize;
    let mut stack: Vec<(Handle, usize)> = vec![(root.clone(), 1)];
    while let Some((node, depth)) = stack.pop() {
        if matches!(node.data, NodeData::Element { .. }) {
            max_depth = max_depth.max(depth);
        }
        let children = node.children.borrow().clone();
        let child_depth = if matches!(node.data, NodeData::Element { .. }) {
            depth + 1
        } else {
            depth
        };
        for child in children {
            stack.push((child, child_depth));
        }
    }
    max_depth
}

/// 문서 전체에서 head를 거쳐 `name` 메타의 content를 찾는다.
pub(crate) fn head_meta(dom: &Dom, name: &str) -> Option<String> {
    let html = first_element_child(&dom.document, "html")?;
    let head = first_element_child(&html, "head")?;
    head_meta_in(&head, name)
}

/// head 서브트리에서 첫 번째 일치 메타의 content를 찾는다(이름 대소문자 무시).
fn head_meta_in(head: &Handle, name: &str) -> Option<String> {
    let mut found = None;
    walk_elements(head, &mut |element| {
        if found.is_some() || !is_html_element(element, "meta") {
            return;
        }
        let meta_name = attr_value(element, "name");
        if meta_name
            .as_deref()
            .is_some_and(|n| n.eq_ignore_ascii_case(name))
        {
            found = attr_value(element, "content");
        }
    });
    found
}

/// 직계 자식 중 첫 번째 html 네임스페이스 요소를 찾는다.
fn first_element_child(parent: &Handle, local: &str) -> Option<Handle> {
    element_children(parent)
        .into_iter()
        .find(|child| is_html_element(child, local))
}

/// 서브트리에서 첫 번째 html 네임스페이스 요소를 트리 순서로 찾는다.
fn find_first_element(root: &Handle, local: &str) -> Option<Handle> {
    let mut found = None;
    walk_elements(root, &mut |element| {
        if found.is_none() && is_html_element(element, local) {
            found = Some(element.clone());
        }
    });
    found
}

/// 문서 전체에서 canonical `article#document`를 찾는다.
fn find_canonical_article(dom: &Dom) -> Option<Handle> {
    let mut found = None;
    walk_elements(&dom.document, &mut |element| {
        if found.is_none()
            && is_html_element(element, "article")
            && attr_value(element, "id").as_deref() == Some("document")
        {
            found = Some(element.clone());
        }
    });
    found
}

// ---------------------------------------------------------------------------
// 정규화 직렬화 — 속성은 (prefix, local) 이름순, 텍스트·속성값은 표준 이스케이프.
// ---------------------------------------------------------------------------

/// 요소와 자손을 정규화 형태로 직렬화한다. 반복문 구현이라 깊은 중첩도 안전하다.
fn serialize_element_into(node: &Handle, out: &mut String) {
    let mut stack: Vec<(Handle, Vec<Handle>, usize)> = Vec::new();
    emit_open_tag(node, out);
    stack.push((node.clone(), child_nodes(node), 0));
    while let Some(top) = stack.last_mut() {
        if top.2 >= top.1.len() {
            let owner = top.0.clone();
            emit_close_tag(&owner, out);
            stack.pop();
            continue;
        }
        let child = top.1[top.2].clone();
        top.2 += 1;
        let raw_owner = is_raw_text_element_node(&top.0);
        match &child.data {
            NodeData::Text { contents } => {
                let text = contents.borrow();
                if raw_owner {
                    out.push_str(&text);
                } else {
                    escape_text_into(&text, out);
                }
            }
            NodeData::Comment { contents } => {
                out.push_str("<!--");
                out.push_str(contents);
                out.push_str("-->");
            }
            NodeData::Element { .. } => {
                emit_open_tag(&child, out);
                let children = child_nodes(&child);
                stack.push((child, children, 0));
            }
            // 요소 아래에는 문서·doctype·PI 노드가 오지 않는다(트리 빌더 계약).
            _ => {}
        }
    }
}

/// 시작 태그를 발행한다. `pre`/`listing`/`textarea`는 재파싱 시 첫 개행이
/// 사라지지 않도록 내용이 개행으로 시작하면 개행을 하나 더 둔다.
fn emit_open_tag(node: &Handle, out: &mut String) {
    let NodeData::Element { name, attrs, .. } = &node.data else {
        return;
    };
    out.push('<');
    out.push_str(&qualified(name));
    let borrowed = attrs.borrow();
    let mut sorted: Vec<&Attribute> = borrowed.iter().collect();
    sorted.sort_by(|a, b| {
        let key = |attr: &Attribute| {
            (
                attr.name.prefix.as_deref().unwrap_or("").to_string(),
                attr.name.local.to_string(),
            )
        };
        key(a).cmp(&key(b))
    });
    for attr in sorted {
        out.push(' ');
        out.push_str(&qualified(&attr.name));
        out.push_str("=\"");
        escape_attr_into(&attr.value, out);
        out.push('"');
    }
    drop(borrowed);
    out.push('>');
    if matches!(&*name.local, "pre" | "listing" | "textarea") {
        if let Some(first) = node.children.borrow().first() {
            if let NodeData::Text { contents } = &first.data {
                if contents.borrow().starts_with('\n') {
                    out.push('\n');
                }
            }
        }
    }
}

fn emit_close_tag(node: &Handle, out: &mut String) {
    let NodeData::Element { name, .. } = &node.data else {
        return;
    };
    // void 요소는 닫는 태그를 내지 않는다.
    if matches!(
        &*name.local,
        "area"
            | "base"
            | "basefont"
            | "bgsound"
            | "br"
            | "col"
            | "embed"
            | "frame"
            | "hr"
            | "img"
            | "input"
            | "keygen"
            | "link"
            | "meta"
            | "param"
            | "source"
            | "track"
            | "wbr"
    ) {
        return;
    }
    out.push_str("</");
    out.push_str(&qualified(name));
    out.push('>');
}

fn is_raw_text_element_node(node: &Handle) -> bool {
    match &node.data {
        NodeData::Element { name, .. } => matches!(
            &*name.local,
            "script" | "style" | "xmp" | "iframe" | "noembed" | "noframes" | "plaintext"
        ),
        _ => false,
    }
}

/// 정규화된 태그·속성 이름. 접두사가 있으면 `prefix:local` 형태다.
fn qualified(name: &QualName) -> String {
    match &name.prefix {
        Some(prefix) => format!("{}:{}", prefix, name.local),
        None => name.local.to_string(),
    }
}

fn escape_text_into(text: &str, out: &mut String) {
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '\0' => out.push('\u{FFFD}'),
            _ => out.push(c),
        }
    }
}

fn escape_attr_into(value: &str, out: &mut String) {
    for c in value.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '\0' => out.push('\u{FFFD}'),
            _ => out.push(c),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 설계 §5의 예시를 기반으로 한 정상 문서 fixture.
    fn normal_fixture() -> String {
        [
            "<!doctype html>",
            "<html lang=\"ko\">",
            "<head>",
            "  <meta charset=\"utf-8\">",
            "  <meta name=\"sawhorse:format\" content=\"shdoc/1\">",
            "  <meta name=\"sawhorse:document-id\" content=\"doc-work-001-spec\">",
            "  <meta name=\"sawhorse:document-profile\" content=\"spec-basic/1\">",
            "  <title>외부 저장소 기여 명세</title>",
            "</head>",
            "<body><main><article id=\"document\">",
            "  <h1>외부 저장소 기여 명세</h1>",
            "  <section id=\"b-repo-clean\" data-sh-kind=\"requirement\">",
            "    <h2>개인 작업 문서는 외부 볼트에 저장한다</h2>",
            "    <p>기여 대상에는 개인 workflow 관리 파일을 추가하지 않는다.</p>",
            "  </section>",
            "  <section id=\"b-repo-review\">",
            "    <p>리뷰 결과는 장부에 남긴다. <code>a &lt; b</code> 비교는 이스케이프된다.</p>",
            "  </section>",
            "</article></main></body></html>",
        ]
        .join("\n")
    }

    #[test]
    fn 정상_문서_파싱() {
        let doc = parse_native_html(&normal_fixture()).expect("파싱 성공해야 한다");
        assert_eq!(doc.format_version, "shdoc/1");
        assert_eq!(doc.document_id, "doc-work-001-spec");
        assert_eq!(doc.profile.as_deref(), Some("spec-basic/1"));
        assert_eq!(doc.lang.as_deref(), Some("ko"));
        assert_eq!(doc.title, "외부 저장소 기여 명세");
        assert_eq!(doc.blocks.len(), 2);
        assert_eq!(doc.blocks[0].block_id, "b-repo-clean");
        assert_eq!(doc.blocks[0].kind.as_deref(), Some("requirement"));
        assert_eq!(doc.blocks[1].block_id, "b-repo-review");
        assert_eq!(doc.blocks[1].kind, None);
        // 속성 이름순 정규화와 텍스트 이스케이프 보존 확인.
        assert!(doc.blocks[0]
            .html
            .starts_with("<section data-sh-kind=\"requirement\" id=\"b-repo-clean\">"));
        assert!(doc.blocks[0]
            .html
            .contains("개인 작업 문서는 외부 볼트에 저장한다"));
        assert!(doc.blocks[1].html.contains("<code>a &lt; b</code>"));
        assert!(doc.blocks[0].html.ends_with("</section>"));
    }

    #[test]
    fn 포맷_감지() {
        assert_eq!(detect_format(&normal_fixture()), DocumentFormat::NativeHtml);
        let upper = normal_fixture().replace("content=\"shdoc/1\"", "content=\"SHDOC/1\"");
        assert_eq!(detect_format(&upper), DocumentFormat::NativeHtml);
        assert_eq!(
            detect_format("---\ntitle: 메모\n---\n\n# 제목\n\n본문입니다."),
            DocumentFormat::LegacyMarkdown
        );
        assert_eq!(
            detect_format("<p>메타 없는 HTML 조각</p>"),
            DocumentFormat::LegacyMarkdown
        );
    }

    #[test]
    fn 포맷_메타가_없으면_파싱_실패() {
        let text = normal_fixture().replace(
            "  <meta name=\"sawhorse:format\" content=\"shdoc/1\">\n",
            "",
        );
        let err = parse_native_html(&text).expect_err("format 메타가 없으면 실패");
        assert!(err.contains("sawhorse:format"), "실제 오류: {err}");
    }

    #[test]
    fn article이_없으면_파싱_실패() {
        let text = normal_fixture().replace("<article id=\"document\">", "<article>");
        let err = parse_native_html(&text).expect_err("canonical article가 없으면 실패");
        assert!(err.contains("article#document"), "실제 오류: {err}");
    }

    #[test]
    fn source_digest_안정성() {
        let a = b"sawhorse".as_slice();
        assert_eq!(source_digest(a), source_digest(a));
        assert_ne!(source_digest(a), source_digest(b"sawhorse!"));
        assert_eq!(source_digest(a).len(), 64);
        // 기대값 고정: 내용이 바뀌면 digest도 바뀌어야 한다.
        assert_eq!(
            source_digest(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn canonical_html_왕복_안정성() {
        let text = normal_fixture();
        let doc = parse_native_html(&text).expect("파싱 성공");
        let canonical = canonical_html(&doc);
        let reparsed = parse_native_html(&canonical).expect("canonical은 다시 파싱되어야 한다");
        assert_eq!(reparsed.document_id, doc.document_id);
        assert_eq!(reparsed.blocks.len(), doc.blocks.len());
        let ids = |d: &ShdocDocument| {
            d.blocks
                .iter()
                .map(|b| b.block_id.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(&reparsed), ids(&doc));
        // canonical은 멱등이어야 한다: 재직렬화해도 같은 bytes.
        assert_eq!(canonical_html(&reparsed), canonical);
        assert!(canonical.starts_with("<!doctype html>\n<html lang=\"ko\">"));
        assert!(canonical.contains("<article id=\"document\">"));
    }

    #[test]
    fn 정규화_왕복_이스케이프와_void_요소_보존() {
        let text = [
            "<!doctype html><html lang=\"ko\"><head>",
            "<meta name=\"sawhorse:format\" content=\"shdoc/1\">",
            "<meta name=\"sawhorse:document-id\" content=\"doc-edges\">",
            "<title>경계 &amp; 값</title></head>",
            "<body><main><article id=\"document\">",
            "<section id=\"b-edge\" data-note=\"따옴표 &quot;와 &amp; 기호\">",
            "<pre>\n코드 블록: 파서는 여는 태그 직후 첫 개행을 규격대로 무시한다.</pre>",
            "<pre>\n\n시작 개행을 포함한 코드는 직렬화 규칙이 보존한다.</pre>",
            "<img src=\"a.png\" alt=\"그림\">",
            "<p>1 &lt; 2 &amp;&amp; 3 &gt; 2</p>",
            "</section></article></main></body></html>",
        ]
        .join("\n");
        let doc = parse_native_html(&text).expect("파싱 성공");
        let block = &doc.blocks[0];
        assert_eq!(block.block_id, "b-edge");
        // 속성값 이스케이프는 다시 파싱해도 같은 값을 유지한다.
        assert!(block
            .html
            .contains("data-note=\"따옴표 &quot;와 &amp; 기호\""));
        // pre 여는 태그 직후 개행 1개는 파싱 규격이 소비한다.
        assert!(block
            .html
            .contains("<pre>코드 블록: 파서는 여는 태그 직후 첫 개행을 규격대로 무시한다.</pre>"));
        // 내용이 개행으로 시작하는 pre는 직렬화 시 개행을 하나 더 둬 왕복을 보존한다.
        assert!(block
            .html
            .contains("<pre>\n\n시작 개행을 포함한 코드는 직렬화 규칙이 보존한다.</pre>"));
        // void 요소는 닫는 태그 없이 재직렬화된다.
        assert!(block.html.contains("<img alt=\"그림\" src=\"a.png\">"));
        assert!(!block
            .html
            .contains("<img alt=\"그림\" src=\"a.png\"></img>"));
        assert!(block.html.contains("<p>1 &lt; 2 &amp;&amp; 3 &gt; 2</p>"));
        // 블록 bytes까지 왕복에서 동일해야 한다.
        let canonical = canonical_html(&doc);
        let reparsed = parse_native_html(&canonical).expect("canonical 재파싱");
        assert_eq!(reparsed.blocks[0].html, block.html);
        assert_eq!(canonical_html(&reparsed), canonical);
    }

    #[test]
    fn 자원_lock_수집과_중복_제거() {
        let text = [
            "<!doctype html><html><head>",
            "<meta name=\"sawhorse:format\" content=\"shdoc/1\">",
            "<meta name=\"sawhorse:document-id\" content=\"doc-assets\">",
            "<title>자원</title></head><body><main><article id=\"document\">",
            "<section id=\"b-imgs\"><p>",
            "<img src=\"assets/figure-1.png\" alt=\"그림\">",
            "<img src=\"assets/figure-1.png\">",
            "<img data-sh-ref=\"docs:b-spec\" src=\"assets/figure-2.png\">",
            "<span data-sh-ref=\"docs:b-spec\">중복 참조</span>",
            "</p></section>",
            "</article></main></body></html>",
        ]
        .join("\n");
        let doc = parse_native_html(&text).expect("파싱 성공");
        let lock = extract_resource_lock(&doc);
        // 등장 순서 유지: img#3은 data-sh-ref가 문서에서 먼저 나왔다.
        assert_eq!(
            lock.assets,
            vec![
                "assets/figure-1.png".to_string(),
                "docs:b-spec".to_string(),
                "assets/figure-2.png".to_string(),
            ]
        );
    }

    #[test]
    fn 크기_한도_초과_파싱_거부() {
        let mut big = String::with_capacity(SHDOC_MAX_BYTES + 8);
        big.push_str("<p>");
        big.push_str(&"x".repeat(SHDOC_MAX_BYTES));
        big.push_str("</p>");
        assert!(big.len() > SHDOC_MAX_BYTES);
        let err = parse_native_html(&big).expect_err("4 MiB 초과는 실패해야 한다");
        assert!(err.contains("4 MiB"), "실제 오류: {err}");
    }
}
