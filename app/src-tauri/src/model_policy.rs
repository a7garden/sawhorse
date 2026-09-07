//! Skills assess the task; the host resolves and persists a model before spawning.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelAssessment {
    pub complexity: Complexity,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Complexity {
    Routine,
    Standard,
    Complex,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelSelection {
    pub source: String,
    pub requested_model: String,
    pub assessment: Option<ModelAssessment>,
    pub reason: String,
}

pub fn resolve(
    agent: &str,
    requested: &str,
    parent: Option<(&str, &str)>,
    policy: &str,
    assessment: Option<&ModelAssessment>,
) -> Result<(String, ModelSelection), String> {
    if let Some(assessment) = assessment {
        if assessment.reason.trim().is_empty() || assessment.reason.len() > 2_000 {
            return Err("모델 판단 근거는 1~2000바이트여야 합니다".into());
        }
        if parent.is_none() {
            return Err("모델 난이도 판단은 하위 실행에만 적용됩니다".into());
        }
    }
    let requested = requested.trim();
    let inherited = parent
        .filter(|(kind, _)| *kind == agent)
        .map(|(_, model)| model)
        .unwrap_or("");
    let (model, source, reason) = if !requested.is_empty() {
        (requested, "explicit", "Requested model")
    } else if parent.is_some() && policy == "auto" && agent == "claude" && assessment.is_some()
        // Unknown/provider-specific models are not silently replaced with public aliases.
        && (inherited.is_empty() || matches!(inherited, "opus" | "opusplan" | "sonnet" | "haiku")
            || inherited.starts_with("claude-opus-") || inherited.starts_with("claude-sonnet-")
            || inherited.starts_with("claude-haiku-"))
    {
        let assessment = assessment.unwrap();
        let model = match assessment.complexity {
            Complexity::Routine | Complexity::Standard => "sonnet",
            Complexity::Complex if inherited == "opus" || inherited.starts_with("claude-opus-") => {
                inherited
            }
            Complexity::Complex => "opus",
        };
        (model, "auto", assessment.reason.as_str())
    } else if parent.is_some() {
        (inherited, "inherited", "Parent model when using the same agent; otherwise CLI default. No automatic mapping without a supported model and task assessment.")
    } else {
        ("", "default", "CLI default model")
    };
    Ok((
        model.into(),
        ModelSelection {
            source: source.into(),
            requested_model: requested.into(),
            assessment: assessment.cloned(),
            reason: reason.into(),
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn assessment(complexity: Complexity) -> ModelAssessment {
        ModelAssessment {
            complexity,
            reason: "Bounded task with an observable check".into(),
        }
    }
    #[test]
    fn skills_route_bounded_work_to_sonnet_and_complex_work_to_opus() {
        for complexity in [Complexity::Routine, Complexity::Standard] {
            let (model, selection) = resolve(
                "claude",
                "",
                Some(("claude", "opus")),
                "auto",
                Some(&assessment(complexity)),
            )
            .unwrap();
            assert_eq!(model, "sonnet");
            assert_eq!(selection.source, "auto");
        }
        assert_eq!(
            resolve(
                "claude",
                "",
                Some(("claude", "sonnet")),
                "auto",
                Some(&assessment(Complexity::Complex))
            )
            .unwrap()
            .0,
            "opus"
        );
    }
    #[test]
    fn explicit_models_opt_out_and_legacy_requests_are_preserved() {
        let a = assessment(Complexity::Routine);
        for (requested, policy, assessment, expected) in [
            ("claude-opus-pinned", "auto", Some(&a), "claude-opus-pinned"),
            ("", "inherit", Some(&a), "opus"),
            ("", "auto", None, "opus"),
        ] {
            assert_eq!(
                resolve(
                    "claude",
                    requested,
                    Some(("claude", "opus")),
                    policy,
                    assessment
                )
                .unwrap()
                .0,
                expected
            );
        }
        assert_eq!(
            resolve("claude", "opus", None, "auto", None).unwrap().0,
            "opus"
        );
    }
    #[test]
    fn provider_models_and_agent_boundaries_do_not_receive_guessed_models() {
        let a = assessment(Complexity::Routine);
        assert_eq!(
            resolve(
                "claude",
                "",
                Some(("claude", "private-model")),
                "auto",
                Some(&a)
            )
            .unwrap()
            .0,
            "private-model"
        );
        assert_eq!(
            resolve("codex", "", Some(("claude", "opus")), "auto", Some(&a))
                .unwrap()
                .0,
            ""
        );
        assert_eq!(
            resolve(
                "codex",
                "",
                Some(("codex", "custom-codex")),
                "auto",
                Some(&a)
            )
            .unwrap()
            .0,
            "custom-codex"
        );
        let mut invalid = a;
        invalid.reason = " ".into();
        assert!(resolve(
            "claude",
            "",
            Some(("claude", "opus")),
            "auto",
            Some(&invalid)
        )
        .is_err());
    }
}
