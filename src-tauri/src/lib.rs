mod commands;

use tauri::webview::PageLoadEvent;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .on_page_load(|webview, payload| {
      if webview.label() != "main" || payload.event() != PageLoadEvent::Finished {
        return;
      }

      let app_handle = webview.app_handle();

      if let Some(main_window) = app_handle.get_webview_window("main") {
        let _ = main_window.show();
        let _ = main_window.set_focus();
      }

      if let Some(startup_window) = app_handle.get_webview_window("startup") {
        let _ = startup_window.destroy();
      }
    })
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // 1) 克隆 AppHandle 用于在异步 Watcher 闭包中发送事件
      let app_handle = app.handle().clone();
      let watcher_res = notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
          if let Ok(event) = res {
              // 2) 如果事件是修改或创建，向前端发送 file-changed 事件
              if event.kind.is_modify() || event.kind.is_create() {
                  for path in event.paths {
                      let path_str = path.to_string_lossy().to_string();
                      use tauri::Emitter;
                      let _ = app_handle.emit("file-changed", path_str);
                  }
              }
          }
      });

      // 3) 将 Watcher 管理至 Tauri 状态中
      match watcher_res {
          Ok(watcher) => {
              app.manage(commands::FileWatcherState(std::sync::Mutex::new(Some(commands::FileWatcher { watcher }))));
          }
          Err(_) => {
              app.manage(commands::FileWatcherState(std::sync::Mutex::new(None)));
          }
      }

      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      commands::open_markdown_file,
      commands::open_markdown_file_by_path,
      commands::open_markdown_folder,
      commands::read_markdown_folder,
      commands::create_markdown_file,
      commands::duplicate_markdown_file,
      commands::delete_markdown_file,
      commands::rename_markdown_file,
      commands::save_markdown_file,
      commands::save_markdown_file_as,
      commands::import_image_asset,
      commands::export_html_file,
      commands::list_installed_browsers,
      commands::open_external_link_in_browser,
      commands::watch_file,
      commands::unwatch_file
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
