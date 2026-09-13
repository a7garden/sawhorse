# Portable Document Contract conformance corpus

`corpus.json` is the machine-readable index. Paths are relative to this directory.

Each implementation should copy a file or set case into an isolated temporary vault and assert the listed result. Operation cases apply the described deterministic action and compare bytes or diagnostics. A test is incomplete if it only parses the body; it must validate the profile-specific transport, shared envelope, body semantics, and expected diagnostic. Set cases are evaluated together in one vault.

Corpus revision 3 is a bootstrap, not an exhaustive test suite. It covers the core Reader classification and initial Writer/Mutator preservation laws for both `pdc-djot/1` and `pdc-html/1`; implementations must also test every normative requirement for their claimed role and body capability. Add a shared regression fixture whenever implementations disagree. A behavior-changing fixture update must accompany the normative specification change that justifies it.
