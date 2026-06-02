use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use rfd::FileDialog;
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
pub struct DocumentHandle {
  path: String,
  content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownFolderHandle {
  root_path: String,
  root_name: String,
  nodes: Vec<MarkdownFolderNode>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownFolderNode {
  name: String,
  path: String,
  kind: String,
  children: Vec<MarkdownFolderNode>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDocumentRequest {
  path: Option<String>,
  content: String,
  suggested_name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedImageAsset {
  saved_path: String,
  markdown_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledBrowserOption {
  id: String,
  name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportImageRequest {
  document_path: String,
  file_name: Option<String>,
  mime_type: Option<String>,
  bytes: Vec<u8>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportHtmlRequest {
  suggested_name: String,
  html_content: String,
}

fn known_browser_paths() -> Vec<(&'static str, &'static str, Vec<PathBuf>)> {
  let program_files = std::env::var_os("ProgramFiles").map(PathBuf::from);
  let program_files_x86 = std::env::var_os("ProgramFiles(x86)").map(PathBuf::from);
  let local_app_data = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);

  let mut candidates = Vec::new();

  let edge_paths = vec![
    program_files
      .as_ref()
      .map(|path| path.join("Microsoft\\Edge\\Application\\msedge.exe")),
    program_files_x86
      .as_ref()
      .map(|path| path.join("Microsoft\\Edge\\Application\\msedge.exe")),
  ]
  .into_iter()
  .flatten()
  .collect::<Vec<_>>();
  candidates.push(("edge", "Microsoft Edge", edge_paths));

  let chrome_paths = vec![
    program_files
      .as_ref()
      .map(|path| path.join("Google\\Chrome\\Application\\chrome.exe")),
    program_files_x86
      .as_ref()
      .map(|path| path.join("Google\\Chrome\\Application\\chrome.exe")),
    local_app_data
      .as_ref()
      .map(|path| path.join("Google\\Chrome\\Application\\chrome.exe")),
  ]
  .into_iter()
  .flatten()
  .collect::<Vec<_>>();
  candidates.push(("chrome", "Google Chrome", chrome_paths));

  let firefox_paths = vec![
    program_files
      .as_ref()
      .map(|path| path.join("Mozilla Firefox\\firefox.exe")),
    program_files_x86
      .as_ref()
      .map(|path| path.join("Mozilla Firefox\\firefox.exe")),
  ]
  .into_iter()
  .flatten()
  .collect::<Vec<_>>();
  candidates.push(("firefox", "Mozilla Firefox", firefox_paths));

  let brave_paths = vec![
    program_files
      .as_ref()
      .map(|path| path.join("BraveSoftware\\Brave-Browser\\Application\\brave.exe")),
    program_files_x86
      .as_ref()
      .map(|path| path.join("BraveSoftware\\Brave-Browser\\Application\\brave.exe")),
    local_app_data
      .as_ref()
      .map(|path| path.join("BraveSoftware\\Brave-Browser\\Application\\brave.exe")),
  ]
  .into_iter()
  .flatten()
  .collect::<Vec<_>>();
  candidates.push(("brave", "Brave", brave_paths));

  candidates
}

fn installed_browser_executables() -> Vec<(String, String, PathBuf)> {
  let mut browsers = Vec::new();

  for (id, name, paths) in known_browser_paths() {
    if let Some(path) = paths.into_iter().find(|candidate| candidate.exists()) {
      browsers.push((id.to_string(), name.to_string(), path));
    }
  }

  browsers
}

fn validate_external_url(url: &str) -> Result<(), String> {
  if url.starts_with("http://") || url.starts_with("https://") {
    Ok(())
  } else {
    Err("仅支持打开 http 或 https 链接".to_string())
  }
}

fn open_with_system_default_browser(url: &str) -> Result<(), String> {
  #[cfg(target_os = "windows")]
  {
    Command::new("rundll32")
      .args(["url.dll,FileProtocolHandler", url])
      .spawn()
      .map_err(|error| error.to_string())?;
    return Ok(());
  }

  #[cfg(target_os = "macos")]
  {
    Command::new("open")
      .arg(url)
      .spawn()
      .map_err(|error| error.to_string())?;
    return Ok(());
  }

  #[cfg(all(unix, not(target_os = "macos")))]
  {
    Command::new("xdg-open")
      .arg(url)
      .spawn()
      .map_err(|error| error.to_string())?;
    return Ok(());
  }

  #[allow(unreachable_code)]
  Err("当前平台暂不支持打开系统浏览器".to_string())
}

fn scan_markdown_folder(path: &PathBuf) -> Result<MarkdownFolderHandle, String> {
  let root_name = path
    .file_name()
    .and_then(|name| name.to_str())
    .map(|name| name.to_string())
    .unwrap_or_else(|| path.to_string_lossy().to_string());

  Ok(MarkdownFolderHandle {
    root_path: path.to_string_lossy().to_string(),
    root_name,
    nodes: build_markdown_folder_nodes(path)?,
  })
}

fn read_document(path: PathBuf) -> Result<DocumentHandle, String> {
  let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
  Ok(DocumentHandle {
    path: path.to_string_lossy().to_string(),
    content,
  })
}

fn write_document(path: PathBuf, content: &str) -> Result<DocumentHandle, String> {
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
  }
  fs::write(&path, content).map_err(|error| error.to_string())?;
  Ok(DocumentHandle {
    path: path.to_string_lossy().to_string(),
    content: content.to_string(),
  })
}

fn sanitize_file_stem(value: &str) -> String {
  let trimmed = value.trim();
  let filtered: String = trimmed
    .chars()
    .map(|ch| {
      if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
        ch
      } else {
        '-'
      }
    })
    .collect();

  let collapsed = filtered.trim_matches('-').to_string();
  if collapsed.is_empty() {
    "image".to_string()
  } else {
    collapsed
  }
}

fn guess_extension(file_name: Option<&str>, mime_type: Option<&str>) -> &'static str {
  if let Some(name) = file_name {
    if let Some(extension) = PathBuf::from(name)
      .extension()
      .and_then(|ext| ext.to_str())
      .map(|ext| ext.to_ascii_lowercase())
    {
      return match extension.as_str() {
        "png" => "png",
        "jpg" | "jpeg" => "jpg",
        "gif" => "gif",
        "webp" => "webp",
        "bmp" => "bmp",
        "svg" => "svg",
        _ => "png",
      };
    }
  }

  match mime_type.unwrap_or_default() {
    "image/jpeg" => "jpg",
    "image/gif" => "gif",
    "image/webp" => "webp",
    "image/bmp" => "bmp",
    "image/svg+xml" => "svg",
    _ => "png",
  }
}

fn relative_markdown_path(target: &PathBuf, base_dir: &PathBuf) -> String {
  let relative = target.strip_prefix(base_dir).unwrap_or(target);
  relative.to_string_lossy().replace('\\', "/")
}

fn is_markdown_file(path: &PathBuf) -> bool {
  path
    .extension()
    .and_then(|extension| extension.to_str())
    .map(|extension| {
      let normalized = extension.to_ascii_lowercase();
      normalized == "md" || normalized == "markdown"
    })
    .unwrap_or(false)
}

fn build_markdown_folder_nodes(path: &PathBuf) -> Result<Vec<MarkdownFolderNode>, String> {
  let mut nodes = Vec::new();
  let entries = fs::read_dir(path).map_err(|error| error.to_string())?;

  for entry in entries {
    let entry = entry.map_err(|error| error.to_string())?;
    let entry_path = entry.path();
    let metadata = entry.metadata().map_err(|error| error.to_string())?;
    let name = entry.file_name().to_string_lossy().to_string();

    if metadata.is_dir() {
      let children = build_markdown_folder_nodes(&entry_path)?;
      nodes.push(MarkdownFolderNode {
        name,
        path: entry_path.to_string_lossy().to_string(),
        kind: "directory".to_string(),
        children,
      });
      continue;
    }

    if metadata.is_file() && is_markdown_file(&entry_path) {
      nodes.push(MarkdownFolderNode {
        name,
        path: entry_path.to_string_lossy().to_string(),
        kind: "file".to_string(),
        children: Vec::new(),
      });
    }
  }

  nodes.sort_by(|left, right| match (left.kind.as_str(), right.kind.as_str()) {
    ("directory", "file") => std::cmp::Ordering::Less,
    ("file", "directory") => std::cmp::Ordering::Greater,
    _ => left.name.to_lowercase().cmp(&right.name.to_lowercase()),
  });

  Ok(nodes)
}

fn unique_file_path(directory: &PathBuf, base_name: &str) -> PathBuf {
  let initial = directory.join(base_name);
  if !initial.exists() {
    return initial;
  }

  let template = PathBuf::from(base_name);
  let stem = template
    .file_stem()
    .and_then(|value| value.to_str())
    .unwrap_or("untitled");
  let extension = template
    .extension()
    .and_then(|value| value.to_str())
    .unwrap_or("md");

  for index in 2.. {
    let candidate = directory.join(format!("{stem}-{index}.{extension}"));
    if !candidate.exists() {
      return candidate;
    }
  }

  initial
}

fn unique_copy_path(path: &PathBuf) -> PathBuf {
  let parent = path.parent().map(PathBuf::from).unwrap_or_default();
  let stem = path
    .file_stem()
    .and_then(|value| value.to_str())
    .unwrap_or("copy");
  let extension = path
    .extension()
    .and_then(|value| value.to_str())
    .unwrap_or("md");

  let initial = parent.join(format!("{stem}-copy.{extension}"));
  if !initial.exists() {
    return initial;
  }

  for index in 2.. {
    let candidate = parent.join(format!("{stem}-copy-{index}.{extension}"));
    if !candidate.exists() {
      return candidate;
    }
  }

  initial
}

fn normalize_markdown_file_name(input: &str, fallback_name: &str) -> Result<String, String> {
  let trimmed = input.trim();
  if trimmed.is_empty() {
    return Err("文件名不能为空".to_string());
  }

  if trimmed.contains('\\') || trimmed.contains('/') {
    return Err("文件名不能包含路径分隔符".to_string());
  }

  let fallback_extension = PathBuf::from(fallback_name)
    .extension()
    .and_then(|value| value.to_str())
    .unwrap_or("md")
    .to_ascii_lowercase();
  let candidate = PathBuf::from(trimmed);
  let normalized = match candidate.extension().and_then(|value| value.to_str()) {
    Some(extension) if matches!(extension.to_ascii_lowercase().as_str(), "md" | "markdown") => {
      trimmed.to_string()
    }
    Some(_) => return Err("只允许使用 .md 或 .markdown 扩展名".to_string()),
    None => format!("{trimmed}.{fallback_extension}"),
  };

  Ok(normalized)
}

#[tauri::command]
pub fn open_markdown_file() -> Result<Option<DocumentHandle>, String> {
  let selected = FileDialog::new()
    .add_filter("Markdown", &["md", "markdown"])
    .pick_file();

  match selected {
    Some(path) => read_document(path).map(Some),
    None => Ok(None),
  }
}

#[tauri::command]
pub fn open_markdown_file_by_path(path: String) -> Result<DocumentHandle, String> {
  read_document(PathBuf::from(path))
}

#[tauri::command]
pub fn open_markdown_folder() -> Result<Option<MarkdownFolderHandle>, String> {
  let selected = FileDialog::new().pick_folder();

  match selected {
    Some(path) => scan_markdown_folder(&path).map(Some),
    None => Ok(None),
  }
}

#[tauri::command]
pub fn read_markdown_folder(path: String) -> Result<MarkdownFolderHandle, String> {
  scan_markdown_folder(&PathBuf::from(path))
}

#[tauri::command]
pub fn create_markdown_file(directory_path: String) -> Result<DocumentHandle, String> {
  let directory = PathBuf::from(directory_path);
  fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
  let file_path = unique_file_path(&directory, "untitled.md");
  write_document(file_path, "")
}

#[tauri::command]
pub fn duplicate_markdown_file(path: String) -> Result<DocumentHandle, String> {
  let source = PathBuf::from(path);
  let content = fs::read_to_string(&source).map_err(|error| error.to_string())?;
  let target = unique_copy_path(&source);
  write_document(target, &content)
}

#[tauri::command]
pub fn delete_markdown_file(path: String) -> Result<(), String> {
  let target = PathBuf::from(path);
  fs::remove_file(target).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn rename_markdown_file(path: String, next_name: String) -> Result<DocumentHandle, String> {
  let source = PathBuf::from(&path);
  let parent = source
    .parent()
    .map(PathBuf::from)
    .ok_or_else(|| "无法确定文件所在目录".to_string())?;
  let current_name = source
    .file_name()
    .and_then(|value| value.to_str())
    .ok_or_else(|| "无法读取当前文件名".to_string())?;
  let normalized_name = normalize_markdown_file_name(&next_name, current_name)?;
  let target = parent.join(&normalized_name);

  if source == target {
    return read_document(source);
  }

  if target.exists() {
    return Err("目标文件已存在".to_string());
  }

  fs::rename(&source, &target).map_err(|error| error.to_string())?;
  read_document(target)
}

#[tauri::command]
pub fn save_markdown_file(request: SaveDocumentRequest) -> Result<Option<DocumentHandle>, String> {
  match request.path {
    Some(path) => write_document(PathBuf::from(path), &request.content).map(Some),
    None => save_markdown_file_as(request),
  }
}

#[tauri::command]
pub fn save_markdown_file_as(
  request: SaveDocumentRequest,
) -> Result<Option<DocumentHandle>, String> {
  let mut dialog = FileDialog::new().add_filter("Markdown", &["md", "markdown"]);
  if let Some(name) = request.suggested_name {
    dialog = dialog.set_file_name(&name);
  }

  match dialog.save_file() {
    Some(path) => write_document(path, &request.content).map(Some),
    None => Ok(None),
  }
}

#[tauri::command]
pub fn import_image_asset(request: ImportImageRequest) -> Result<ImportedImageAsset, String> {
  let document_path = PathBuf::from(&request.document_path);
  let document_dir = document_path
    .parent()
    .ok_or_else(|| "无法确定文档所在目录".to_string())?;

  let assets_dir = document_dir.join("assets");
  fs::create_dir_all(&assets_dir).map_err(|error| error.to_string())?;

  let original_name = request.file_name.as_deref().unwrap_or("image");
  let file_stem = PathBuf::from(original_name)
    .file_stem()
    .and_then(|stem| stem.to_str())
    .map(sanitize_file_stem)
    .unwrap_or_else(|| "image".to_string());
  let extension = guess_extension(request.file_name.as_deref(), request.mime_type.as_deref());
  let timestamp = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map_err(|error| error.to_string())?
    .as_millis();

  let file_name = format!("{file_stem}-{timestamp}.{extension}");
  let saved_path = assets_dir.join(&file_name);
  fs::write(&saved_path, request.bytes).map_err(|error| error.to_string())?;

  Ok(ImportedImageAsset {
    saved_path: saved_path.to_string_lossy().to_string(),
    markdown_path: relative_markdown_path(&saved_path, &document_dir.to_path_buf()),
  })
}

#[tauri::command]
pub fn export_html_file(request: ExportHtmlRequest) -> Result<Option<String>, String> {
  let dialog = FileDialog::new()
    .add_filter("HTML", &["html"])
    .set_file_name(&request.suggested_name);

  match dialog.save_file() {
    Some(path) => {
      fs::write(&path, request.html_content).map_err(|error| error.to_string())?;
      Ok(Some(path.to_string_lossy().to_string()))
    }
    None => Ok(None),
  }
}

#[tauri::command]
pub fn list_installed_browsers() -> Result<Vec<InstalledBrowserOption>, String> {
  let mut browsers = vec![InstalledBrowserOption {
    id: "system-default".to_string(),
    name: "系统默认浏览器".to_string(),
  }];

  browsers.extend(
    installed_browser_executables()
      .into_iter()
      .map(|(id, name, _path)| InstalledBrowserOption { id, name }),
  );

  Ok(browsers)
}

#[tauri::command]
pub fn open_external_link_in_browser(url: String, browser_id: String) -> Result<(), String> {
  validate_external_url(&url)?;

  if browser_id == "system-default" {
    return open_with_system_default_browser(&url);
  }

  let browser = installed_browser_executables()
    .into_iter()
    .find(|(id, _name, _path)| id == &browser_id)
    .ok_or_else(|| "未找到所选浏览器，请重新选择".to_string())?;

  Command::new(browser.2)
    .arg(url)
    .spawn()
    .map_err(|error| error.to_string())?;

  Ok(())
}
