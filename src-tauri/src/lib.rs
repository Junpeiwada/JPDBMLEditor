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

// ネイティブメニューの「アップデートを確認」項目の ID。
// クリック時にこの ID を判定し、フロントへイベントを emit する。
#[cfg(desktop)]
const MENU_CHECK_UPDATE: &str = "check-update";
// メニュークリックをフロントへ伝えるイベント名（useAppUpdater 側で listen する）。
#[cfg(desktop)]
const EVENT_CHECK_UPDATE: &str = "menu://check-update";

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

    // ネイティブメニュー（デスクトップのみ）。OS 標準メニュー（コピー/ペースト/閉じる等）を
    // 土台にし、「ヘルプ」サブメニューへ「アップデートを確認」を足す。クリックはイベントで
    // フロントへ渡し、useAppUpdater の手動チェックを走らせる（ツールバーのボタンと同じ経路）。
    #[cfg(desktop)]
    {
        use tauri::menu::{Menu, MenuItem, Submenu};
        use tauri::Emitter;

        builder = builder
            .setup(|app| {
                let handle = app.handle();
                // OS 標準メニュー(コピー/ペースト/閉じる等)を土台にして独自項目を足す。
                // 注: Menu::default が既に「ヘルプ」を含む構成だと、メニューバーに「ヘルプ」が
                // 2 つ並ぶ可能性がある。実機で重複したら既存サブメニューへ寄せるか名称変更する。
                let menu = Menu::default(handle)?;
                let check_update =
                    MenuItem::with_id(handle, MENU_CHECK_UPDATE, "アップデートを確認", true, None::<&str>)?;
                let help = Submenu::with_items(handle, "ヘルプ", true, &[&check_update])?;
                menu.append(&help)?;
                app.set_menu(menu)?;
                Ok(())
            })
            .on_menu_event(|app, event| {
                if event.id() == MENU_CHECK_UPDATE {
                    // フロントへ通知（受け手が無くても害はない）。
                    let _ = app.emit(EVENT_CHECK_UPDATE, ());
                }
            });
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![toggle_devtools])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
