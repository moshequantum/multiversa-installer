//! MultiversaOS visual installer — Tauri backend.
//!
//! This layer deliberately owns almost no logic. Every operation that changes
//! the user's machine is delegated to the `multiversa` CLI, which is the single
//! source of truth for the tenant DNA schema, the vault permissions and the
//! engine install strategies.
//!
//! The previous implementation wrote its own `multiversa.toml` in Rust. That
//! produced a manifest missing `[identity]`, `[agents]`, `[stack]` and
//! `[credits]` — the two implementations had already drifted. It also hardcoded
//! `/home/moshe` into its prerequisite probes, so it only ever worked on one
//! machine, and it treated Homebrew as mandatory, which made Linux look broken.
//!
//! Rule for anyone extending this file: if a command mutates state, it shells
//! out to the CLI. If you find yourself writing TOML here, stop.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// One unit of real work during install. The frontend renders progress from
/// these events only — there is no simulated timer anywhere in this app.
#[derive(Clone, Serialize)]
pub struct InstallEvent {
    /// Stable id of the stage, for the UI to key on.
    pub stage: String,
    /// "running" | "done" | "error"
    pub status: String,
    /// Human-readable line for the console.
    pub message: String,
    /// Completed stages / total stages. The UI derives the bar from this.
    pub completed: usize,
    pub total: usize,
}

#[derive(Debug, Deserialize)]
pub struct PillarInput {
    pub name: String,
    #[serde(default)]
    pub metric: String,
}

/// One connection key the user chose to store. `key` is an env var name
/// (ELEVENLABS_API_KEY, …); `value` is the secret, which is passed to the CLI
/// over stdin and never placed in a process argument or logged.
#[derive(Debug, Deserialize)]
pub struct SecretInput {
    pub key: String,
    pub value: String,
}

/// Resolves the `multiversa` binary. Checks PATH first, then the two locations
/// the shell installer and `go install` use. Returns None when the CLI is
/// genuinely absent so the UI can say so instead of failing obscurely.
fn locate_cli() -> Option<PathBuf> {
    if let Ok(output) = Command::new("which").arg("multiversa").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return Some(PathBuf::from(path));
            }
        }
    }
    // No hardcoded user: derive from the running user's HOME.
    let home = std::env::var("HOME").ok()?;
    for candidate in [".local/bin/multiversa", "go/bin/multiversa"] {
        let p = PathBuf::from(&home).join(candidate);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

/// Runs the CLI and returns its parsed `--json` envelope.
fn cli_binary() -> Result<PathBuf, String> {
    locate_cli().ok_or_else(|| {
        "No se encontró el CLI `multiversa`. Instálalo primero — el instalador \
         visual es una capa sobre él, no un reemplazo."
            .to_string()
    })
}

/// Parses the CLI's `--json` envelope from raw stdout/stderr, surfacing a
/// failure reported inside the envelope (ok:false) as an Err.
fn parse_envelope(stdout: &[u8], stderr: &[u8]) -> Result<serde_json::Value, String> {
    let out = String::from_utf8_lossy(stdout);
    let parsed: serde_json::Value = serde_json::from_str(&out).map_err(|_| {
        let err = String::from_utf8_lossy(stderr);
        let detail = if err.trim().is_empty() {
            out.trim().to_string()
        } else {
            err.trim().to_string()
        };
        format!("El CLI no devolvió JSON válido: {detail}")
    })?;

    if parsed.get("ok").and_then(|v| v.as_bool()) == Some(false) {
        let msg = parsed
            .pointer("/error/message")
            .and_then(|v| v.as_str())
            .unwrap_or("error desconocido del CLI");
        return Err(msg.to_string());
    }
    Ok(parsed)
}

fn run_cli(args: &[String]) -> Result<serde_json::Value, String> {
    let cli = cli_binary()?;
    let output = Command::new(&cli)
        .args(args)
        .output()
        .map_err(|e| format!("No se pudo ejecutar {}: {e}", cli.display()))?;
    parse_envelope(&output.stdout, &output.stderr)
}

/// Like run_cli but feeds `stdin_value` to the child's stdin. This is how a
/// secret reaches `tenant set-secret` without ever appearing in a process
/// argument (and therefore never in `ps` or the shell history).
fn run_cli_stdin(args: &[String], stdin_value: &str) -> Result<serde_json::Value, String> {
    let cli = cli_binary()?;
    let mut child = Command::new(&cli)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("No se pudo ejecutar {}: {e}", cli.display()))?;

    child
        .stdin
        .take()
        .ok_or_else(|| "No se pudo abrir la entrada del CLI".to_string())?
        .write_all(stdin_value.as_bytes())
        .map_err(|e| format!("No se pudo enviar el valor al CLI: {e}"))?;
    // stdin drops here, closing the pipe so the child sees EOF.

    let output = child
        .wait_with_output()
        .map_err(|e| format!("El CLI no terminó correctamente: {e}"))?;
    parse_envelope(&output.stdout, &output.stderr)
}

/// Reports what the machine actually has, by asking the CLI's own detector.
///
/// Note there is no "brew" key any more: Homebrew is one install strategy among
/// several, not a prerequisite. Reporting it as required is what made this
/// installer tell Ubuntu users they were missing something they do not need.
#[tauri::command]
fn check_prerequisites() -> Result<serde_json::Value, String> {
    let report = run_cli(&["detect".into(), "--json".into()])?;
    let report = report
        .pointer("/data/report")
        .ok_or_else(|| "El CLI devolvió un informe de detección vacío".to_string())?;

    Ok(serde_json::json!({
        "os": report.get("os").cloned().unwrap_or(serde_json::Value::Null),
        "tools": report.get("tools").cloned().unwrap_or(serde_json::Value::Null),
        "multiversa": report.get("multiversa").cloned().unwrap_or(serde_json::Value::Null),
    }))
}

/// True when the CLI is present — lets the UI degrade honestly instead of
/// pretending the install worked.
#[tauri::command]
fn cli_available() -> bool {
    locate_cli().is_some()
}

fn require_project_os_cli() -> Result<(), String> {
    let envelope = run_cli(&["capabilities".into(), "--json".into()]).map_err(|_| {
        "El CLI instalado es incompatible: falta `multiversa capabilities`. Actualiza el CLI antes de continuar.".to_string()
    })?;
    let supported = envelope
        .pointer("/data/profile_schemas")
        .and_then(|v| v.as_array())
        .map(|items| items.iter().any(|v| v.as_str() == Some("0.3-read-write")))
        .unwrap_or(false);
    if !supported {
        return Err("El CLI no declara soporte de escritura para Profile 0.3.".to_string());
    }
    Ok(())
}

/// Creates the tenant and activates it, emitting one event per real step.
///
/// Every stage corresponds to a command that actually ran. If a stage fails,
/// the error is returned and no later stage is reported as done — the previous
/// version kept a timer running and printed "instalación finalizada con éxito"
/// even when the write had failed.
#[tauri::command]
async fn create_tenant(
    app: AppHandle,
    slug: String,
    name: String,
    kind: String,
    pillars: Vec<PillarInput>,
    secrets: Vec<SecretInput>,
) -> Result<serde_json::Value, String> {
    require_project_os_cli()?;
    // Accepted for frontend/API compatibility. Every new OS is project-os;
    // audience or customer names never select a reusable template.
    let _ = kind;
    // Only non-empty connections count as work. An empty field in the
    // Conexiones form is a connection the user chose to skip, not a stage.
    let secrets: Vec<&SecretInput> = secrets
        .iter()
        .filter(|s| !s.key.trim().is_empty() && !s.value.trim().is_empty())
        .collect();

    // total = create + activate, plus one stage if there are secrets to store.
    let total = if secrets.is_empty() { 2 } else { 3 };
    let mut completed = 0usize;
    let emit = |stage: &str, status: &str, message: String, completed: usize| {
        let _ = app.emit(
            "install-progress",
            InstallEvent {
                stage: stage.to_string(),
                status: status.to_string(),
                message,
                completed,
                total,
            },
        );
    };

    // ── Stage 1: create the tenant (this is what makes the vault exist) ──
    emit(
        "tenant",
        "running",
        format!("Creando el perfil «{name}» en ~/.multiversa/tenants/{slug}/"),
        completed,
    );

    let mut args: Vec<String> = vec![
        "tenant".into(),
        "new".into(),
        slug.clone(),
        "--name".into(),
        name.clone(),
        "--kind".into(),
        "project-os".into(),
        "--json".into(),
    ];
    for p in &pillars {
        let name = p.name.trim();
        if name.is_empty() {
            continue;
        }
        let metric = p.metric.trim();
        args.push("--pillar".into());
        args.push(if metric.is_empty() {
            name.to_string()
        } else {
            format!("{name}={metric}")
        });
    }

    let created = match run_cli(&args) {
        Ok(v) => v,
        Err(e) => {
            emit("tenant", "error", e.clone(), completed);
            return Err(e);
        }
    };
    completed += 1;

    let dir = created
        .pointer("/data/dir")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    emit(
        "tenant",
        "done",
        format!("Perfil creado · vault con permisos 0700 en {dir}"),
        completed,
    );

    // ── Stage 2 (optional): store connection keys in the vault ──
    // Each value goes over stdin, never in an argument. If one fails, the whole
    // install fails here — we do not report a partly-configured OS as done.
    if !secrets.is_empty() {
        emit(
            "secrets",
            "running",
            format!("Guardando {} conexión(es) en tu bóveda", secrets.len()),
            completed,
        );
        for s in &secrets {
            let key = s.key.trim().to_string();
            let res = run_cli_stdin(
                &[
                    "tenant".into(),
                    "set-secret".into(),
                    slug.clone(),
                    key.clone(),
                    "--json".into(),
                ],
                &s.value,
            );
            if let Err(e) = res {
                // Name the key that failed, never its value.
                let msg = format!("No se pudo guardar «{key}»: {e}");
                emit("secrets", "error", msg.clone(), completed);
                return Err(msg);
            }
        }
        completed += 1;
        emit(
            "secrets",
            "done",
            format!(
                "{} conexión(es) guardada(s) — cifradas por permisos, nunca salen de tu máquina",
                secrets.len()
            ),
            completed,
        );
    }

    // ── Final stage: activate the tenant ──
    emit("activate", "running", format!("Activando «{slug}»"), completed);
    if let Err(e) = run_cli(&[
        "tenant".into(),
        "use".into(),
        slug.clone(),
        "--json".into(),
    ]) {
        emit("activate", "error", e.clone(), completed);
        return Err(e);
    }
    completed += 1;
    emit(
        "activate",
        "done",
        format!("«{slug}» es ahora el tenant activo"),
        completed,
    );

    Ok(created)
}

/// Speaks a line through ElevenLabs, returning a data URI so the webview can
/// play it without a CORS round trip. The key stays in memory: it is never
/// written to disk, and never to a shared MCP config.
#[tauri::command]
async fn tts_elevenlabs(api_key: String, voice_id: String, text: String) -> Result<String, String> {
    let url = format!("https://api.elevenlabs.io/v1/text-to-speech/{voice_id}");
    let payload = serde_json::json!({
        "text": text,
        "model_id": "eleven_multilingual_v2",
        "voice_settings": { "stability": 0.5, "similarity_boost": 0.75 }
    });

    let response = ureq::post(&url)
        .set("Content-Type", "application/json")
        .set("xi-api-key", &api_key)
        .send_json(payload)
        .map_err(|e| format!("No se pudo contactar a ElevenLabs: {e}"))?;

    if response.status() != 200 {
        return Err(format!("ElevenLabs respondió {}", response.status()));
    }

    let mut reader = response.into_reader();
    let mut bytes = Vec::new();
    std::io::copy(&mut reader, &mut bytes)
        .map_err(|e| format!("No se pudo leer el audio: {e}"))?;

    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:audio/mpeg;base64,{b64}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            check_prerequisites,
            cli_available,
            create_tenant,
            tts_elevenlabs
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
