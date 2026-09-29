use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use crate::Runtime;

const URL: &str = "https://netcare.huawei.com/p/netcare/new.html#/iframe/iframe-page/%2Fadc-web%2Fui%2Fstandalone%2Findex.html%23%2Fspl2%2Fcs_nc_network_tuning_query%2Fnt_workflow_rfc_getList_for_report%3Fbg_type=EBG&title=%25E5%258F%2598%25E6%259B%25B4%25E5%2588%2597%25E8%25A1%25A8&title_en=RFC%2520List";

pub fn open(app: &tauri::AppHandle, state: Arc<Runtime>, clear: bool, request_id: String) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(window) = app.get_webview_window("netcare-login") {
        window.destroy()?;
    }
    let profile = crate::install_directory()?.join("netcare-webview");
    std::fs::create_dir_all(&profile)?;
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let script = format!(r#"
        (() => {{
          if (window.top !== window || location.origin !== 'https://netcare.huawei.com') return;
          const timer = setInterval(() => {{
            const token = localStorage.getItem('csrfTokens');
            if (token && location.pathname.startsWith('/p/netcare/')) {{
              location.href = 'netcare-session://ready/{nonce}?csrf=' + encodeURIComponent(token);
            }}
          }}, 5000);
        }})();
    "#);
    let nav_app = app.clone();
    let nav_state = state.clone();
    let nav_id = request_id.clone();
    let captured = Arc::new(AtomicBool::new(false));
    let window = WebviewWindowBuilder::new(app, "netcare-login", WebviewUrl::External("about:blank".parse()?))
        .title("登录 Netcare · 登录成功后自动关闭")
        .data_directory(profile)
        .inner_size(1060.0, 780.0).min_inner_size(760.0, 600.0).center()
        .initialization_script(script)
        .on_navigation(move |url| {
            if url.scheme() == "netcare-session" {
                if url.host_str() != Some("ready") || url.path() != format!("/{nonce}") { return false; }
                let Some(window) = nav_app.get_webview_window("netcare-login") else { return false; };
                if !window.url().ok().is_some_and(|current| current.origin().ascii_serialization() == "https://netcare.huawei.com") { return false; }
                let csrf = url.query_pairs().find(|(key, _)| key == "csrf").map(|(_, value)| value.into_owned());
                if let Some(csrf) = csrf.filter(|s| !s.is_empty() && s.len() < 16000) {
                    if !captured.swap(true, Ordering::SeqCst) {
                        let state = nav_state.clone();
                        let id = nav_id.clone();
                        let captured = captured.clone();
                        // WebView2 的同步 Cookie API 必须在事件线程之外调用。
                        std::thread::spawn(move || {
                            match window.cookies_for_url("https://netcare.huawei.com/adc-service/".parse().unwrap()) {
                                Ok(cookies) => {
                                    let cookie = cookies.iter().map(|c| format!("{}={}", c.name(), c.value())).collect::<Vec<_>>().join("; ");
                                    state.send(&serde_json::json!({"event":"netcare_credentials", "requestId":id,"cookie":cookie, "csrfToken":csrf}));
                                }
                                Err(_) => { state.send(&serde_json::json!({"event":"netcare_login_error", "requestId":id,"message":"无法读取登录会话，请关闭窗口后重试"})); }
                            }
                            captured.store(false, Ordering::SeqCst);
                        });
                    }
                }
                return false;
            }
            url.as_str() == "about:blank" || (url.scheme() == "https" && url.host_str().is_some_and(|host| host == "huawei.com" || host.ends_with(".huawei.com")))
        })
        .build()?;
    if clear { window.clear_all_browsing_data()?; }
    let close_state = state.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            close_state.send(&serde_json::json!({"event":"netcare_login_closed","requestId":request_id}));
        }
    });
    window.navigate(URL.parse()?)?;
    Ok(())
}

pub fn close(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("netcare-login") { let _ = window.close(); }
}

// 与 Netcare 共用软件内的 WebView2 配置，由统一登录完成导出服务的会话交换。
pub fn open_export(app: &tauri::AppHandle, state: Arc<Runtime>, request_id: String, number: String) -> Result<(), Box<dyn std::error::Error>> {
    let number_ok = number.len() == 16 && number.starts_with("NE") && number[2..].bytes().all(|b| b.is_ascii_digit());
    if !number_ok { return Err("invalid RFC number".into()); }
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let script = format!(r#"
      (() => {{
        if (window.top !== window || location.origin !== 'https://kdp.idp.huawei.com') return;
        let busy = false;
        setInterval(async () => {{
          if (busy) return;
          busy = true;
          try {{
            const r = await fetch('/ows1/services/sso/getloginuser', {{credentials:'include'}});
            const u = await r.json();
            if (u.uid && u.employeeNumber) location.href = 'netcare-export://ready/{nonce}?csrf=' + encodeURIComponent(u.employeeNumber) + '&username=' + encodeURIComponent(u.uid);
          }} catch {{}} finally {{ busy = false; }}
        }}, 2000);
      }})();
    "#);
    let nav_app = app.clone();
    let nav_state = state.clone();
    let nav_id = request_id.clone();
    let captured = Arc::new(AtomicBool::new(false));
    let target = format!("https://kdp.idp.huawei.com/ows1/static/editor/IdpLiteView/PublishLiteView.html?id={number}&language=zh&from=ows");
    let window = WebviewWindowBuilder::new(app, "netcare-export", WebviewUrl::External(target.parse()?))
        .title("连接方案导出服务 · 连接后自动关闭")
        .data_directory(crate::install_directory()?.join("netcare-webview"))
        .inner_size(900.0, 700.0).center()
        .initialization_script(script)
        .on_navigation(move |url| {
            if url.scheme() == "netcare-export" {
                if url.host_str() != Some("ready") || url.path() != format!("/{nonce}") { return false; }
                let Some(window) = nav_app.get_webview_window("netcare-export") else { return false; };
                if !window.url().ok().is_some_and(|u| u.origin().ascii_serialization() == "https://kdp.idp.huawei.com") { return false; }
                let csrf = url.query_pairs().find(|(k,_)| k == "csrf").map(|(_,v)| v.into_owned());
                let username = url.query_pairs().find(|(k,_)| k == "username").map(|(_,v)| v.into_owned());
                if let (Some(csrf), Some(username)) = (csrf, username) {
                    if !captured.swap(true, Ordering::SeqCst) {
                        let state = nav_state.clone(); let id = nav_id.clone();
                        std::thread::spawn(move || {
                            if let Ok(cookies) = window.cookies_for_url("https://kdp.idp.huawei.com/ows1/services/".parse().unwrap()) {
                                let cookie = cookies.iter().map(|c| format!("{}={}",c.name(),c.value())).collect::<Vec<_>>().join("; ");
                                state.send(&serde_json::json!({"event":"netcare_export_credentials","requestId":id,"cookie":cookie,"csrfToken":csrf,"username":username}));
                            } else { state.send(&serde_json::json!({"event":"netcare_export_error","requestId":id})); }
                        });
                    }
                }
                return false;
            }
            url.scheme() == "https" && url.host_str().is_some_and(|h| h == "huawei.com" || h.ends_with(".huawei.com"))
        }).build()?;
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) { state.send(&serde_json::json!({"event":"netcare_export_closed","requestId":request_id})); }
    });
    Ok(())
}
pub fn close_export(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("netcare-export") { let _ = window.close(); }
}
