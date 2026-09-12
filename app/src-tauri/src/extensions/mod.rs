// Extension layer. Design lines 577-679: separates packs (existing declarative) from
// connectors (permission-gated external adapters). Both appear to users as 「확장」 (Extensions).
//
// Invariant 7: connectors submit only intents to the core and never write Git, vault, or DB directly.

pub mod broker;
pub mod feeds;
pub mod github;
pub mod github_outbound;
pub mod manifest;
pub mod package;
mod resolver;
pub mod signing;

pub mod github_management;
