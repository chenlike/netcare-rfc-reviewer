#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Write},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU16, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

#[derive(Default)]
struct Runtime {
    child: Mutex<Option<Child>>,
    closing: AtomicBool,
    port: AtomicU16,
}
impl Runtime {
    fn stop(&self) {
        if let Some(mut child) = self.child.lock().unwrap().take() {
            if let Some(mut input) = child.stdin.take() {
                let _ = input.write_all(b"shutdown\n");
            }
            for _ in 0..120 {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
fn log_line(log: &Arc<Mutex<File>>, line: &str) {
    if let Ok(mut file) = log.lock() {
        let _ = writeln!(file, "{line}");
    }
}
fn failure(app: &tauri::AppHandle, message: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let title = serde_json::to_string("启动失败").unwrap();
        let text = serde_json::to_string(message).unwrap();
        let _ = window.eval(&format!("document.getElementById('title').textContent={title};document.getElementById('status').textContent={text};document.getElementById('progress').style.display='none'"));
    }
}
fn start_runtime(
    app: tauri::AppHandle,
    state: Arc<Runtime>,
) -> Result<(), Box<dyn std::error::Error>> {
    let data = app.path().app_local_data_dir()?;
    fs::create_dir_all(data.join("logs"))?;
    let logfile = data.join("logs/engine.log");
    if fs::metadata(&logfile)
        .map(|m| m.len() > 5_000_000)
        .unwrap_or(false)
    {
        let _ = fs::rename(&logfile, data.join("logs/engine.previous.log"));
    }
    let log = Arc::new(Mutex::new(
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&logfile)?,
    ));
    let root = app.path().resource_dir()?.join("runtime");
    let secret = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let mut command = Command::new(root.join("node.exe"));
    command
        .arg(root.join("dist/server/index.js"))
        .current_dir(&root)
        .env("DATA_DIRECTORY", data.join("data"))
        .env("STUDIO_DESKTOP", "1")
        .env("STUDIO_DESKTOP_SECRET", &secret)
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn()?;
    let output = child.stdout.take().ok_or("未能读取审核引擎启动信息")?;
    let errors = child.stderr.take().ok_or("未能读取审核引擎日志")?;
    let mut slot = state.child.lock().unwrap();
    if state.closing.load(Ordering::SeqCst) {
        let _ = child.kill();
        return Ok(());
    }
    *slot = Some(child);
    drop(slot);
    let err_log = log.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(errors).lines().map_while(Result::ok) {
            log_line(&err_log, &line);
        }
    });
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(output).lines().map_while(Result::ok) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                if value["event"] == "desktop_ready" {
                    if let Some(port) = value["port"].as_u64().filter(|p| *p > 0 && *p <= 65535) {
                        let _ = sender.send(port as u16);
                    }
                }
            }
            log_line(&log, &line);
        }
    });
    let port = receiver
        .recv_timeout(Duration::from_secs(45))
        .map_err(|_| {
            format!(
                "审核引擎未能启动。请关闭后重新打开。\n日志：{}",
                logfile.display()
            )
        })?;
    state.port.store(port, Ordering::SeqCst);
    if !state.closing.load(Ordering::SeqCst) {
        if let Some(window) = app.get_webview_window("main") {
            window.navigate(
                format!("http://127.0.0.1:{port}/desktop/open?session={secret}").parse()?,
            )?;
        }
    }
    Ok(())
}
fn main() {
    let state = Arc::new(Runtime::default());
    let setup_state = state.clone();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .setup(move |app| {
            let nav_state = setup_state.clone();
            let window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("RFC Studio · 方案审核工作台")
                    .inner_size(1440.0, 960.0)
                    .min_inner_size(960.0, 680.0)
                    .center()
                    .devtools(cfg!(debug_assertions))
                    .disable_drag_drop_handler()
                    .on_navigation(move |url| {
                        url.scheme() == "tauri"
                            || url.host_str() == Some("tauri.localhost")
                            || url.as_str() == "about:srcdoc"
                            || (url.scheme() == "http"
                                && url.host_str() == Some("127.0.0.1")
                                && url.port() == Some(nav_state.port.load(Ordering::SeqCst)))
                    })
                    .build()?;
            let handle = app.handle().clone();
            let close_state = setup_state.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    if !close_state.closing.swap(true, Ordering::SeqCst) {
                        let state = close_state.clone();
                        let handle = handle.clone();
                        if let Some(w) = handle.get_webview_window("main") {
                            let _ = w.hide();
                        }
                        std::thread::spawn(move || {
                            state.stop();
                            handle.exit(0);
                        });
                    }
                }
            });
            let handle = app.handle().clone();
            let runtime = setup_state.clone();
            std::thread::spawn(move || {
                if let Err(error) = start_runtime(handle.clone(), runtime.clone()) {
                    failure(&handle, &error.to_string());
                    runtime.stop();
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("无法启动 RFC Studio");
    app.run(move |_, event| {
        if let tauri::RunEvent::Exit = event {
            state.stop();
        }
    });
}
