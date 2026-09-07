// A console binary on Windows as well as macOS. Do not use the GUI subsystem.
fn main() -> std::process::ExitCode {
    sawhorse_dashboard_lib::cli::run()
}
