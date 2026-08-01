// Vendored BUILD HELPER (not upstream code). Decodes a Palworld PlM1/Oodle
// `.sav` container to its GVAS JSON on stdout, using `psp-core` from
// oMaN-Rod/palworld-save-pal (MIT) via the pinned Dhampyru fork. Pure-Rust
// Kraken decompression (palworld-save-pal/ooz-rs) -- no proprietary Oodle DLL.
//
// The Dockerfile's `savtools` stage clones the pinned fork, drops this file in
// as `psp-core/examples/psp-decode.rs`, and `cargo build`s it so it links
// against psp-core inside its own workspace. See savtools/NOTICE for attribution.
//
// Contract: `psp-decode <path.sav>` -> GVAS JSON on stdout (exit 0), or an error
// on stderr (exit 1 decode failure, exit 2 read failure).
fn main() {
    let path = match std::env::args().nth(1) {
        Some(p) => p,
        None => {
            eprintln!("usage: psp-decode <path.sav>");
            std::process::exit(2);
        }
    };
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("read error: {e}");
            std::process::exit(2);
        }
    };
    match psp_core::convert::sav_to_json_string(&bytes) {
        Ok(json) => print!("{json}"),
        Err(e) => {
            eprintln!("decode error: {e:?}");
            std::process::exit(1);
        }
    }
}
