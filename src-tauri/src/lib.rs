// F12 で開発者ツール(Inspect Element)をトグルする。
// devtools は debug ビルドでのみ利用可能なため、リリースビルドでは何もしない
// (フロントは常に呼び出すが、release ではこのコマンドは実質no-op)。
#[tauri::command]
fn toggle_devtools(_window: tauri::WebviewWindow) {
    #[cfg(debug_assertions)]
    {
        if _window.is_devtools_open() {
            _window.close_devtools();
        } else {
            _window.open_devtools();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // ウィンドウ位置・サイズの永続化（デスクトップのみ）。
    // 画面外にはみ出す位置は復元時に自動でデフォルトへフォールバックされる。
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_window_state::Builder::default().build())
            // 自動アップデート（デスクトップのみ）。process はアップデート適用後の再起動に使う。
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init());
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![toggle_devtools])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
