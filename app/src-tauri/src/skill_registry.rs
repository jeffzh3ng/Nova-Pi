use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::ffi::OsStr;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const MAX_SKILL_ENTRY_BYTES: u64 = 128 * 1024;
const MAX_SKILL_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_SKILL_INSTALL_BYTES: u64 = 20 * 1024 * 1024;
const MAX_SKILL_ZIP_SEARCH_DEPTH: usize = 4;
const MAX_SKILL_EXECUTION_INPUT_BYTES: usize = 512 * 1024;
const SKILL_EXECUTION_TIMEOUT: Duration = Duration::from_secs(90);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillManifest {
    pub id: String,
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub keywords: Vec<String>,
    #[serde(default)]
    pub triggers: Vec<String>,
    #[serde(default = "default_entry")]
    pub entry: String,
    #[serde(default = "default_runtime")]
    pub runtime: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub permissions: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    #[serde(default)]
    pub can_delete: bool,
    #[serde(default = "default_enabled")]
    pub can_toggle: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDefinition {
    pub manifest: SkillManifest,
    pub entry_content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillLoadError {
    pub source: String,
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillCatalog {
    pub skills: Vec<SkillManifest>,
    pub errors: Vec<SkillLoadError>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillExecutionPlanRequest {
    pub id: String,
    pub skill_id: String,
    pub input_file_name: String,
    pub input_content: String,
    pub output_file_name: String,
    pub output_format: String,
    #[serde(default)]
    pub parameters: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillExecutionResult {
    pub path: String,
    pub file_name: String,
    pub input_path: String,
    pub command_preview: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdout: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr: Option<String>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillRegistryState {
    #[serde(default)]
    disabled_skill_ids: Vec<String>,
}

fn default_entry() -> String {
    "SKILL.md".to_string()
}

fn default_runtime() -> String {
    "instruction".to_string()
}

fn default_enabled() -> bool {
    true
}

#[tauri::command]
pub fn list_skills(app: AppHandle) -> Result<Vec<SkillManifest>, String> {
    Ok(build_skill_catalog(&app)?.skills)
}

#[tauri::command]
pub fn list_skill_catalog(app: AppHandle) -> Result<SkillCatalog, String> {
    build_skill_catalog(&app)
}

#[tauri::command]
pub fn set_skill_enabled(
    app: AppHandle,
    skill_id: String,
    enabled: bool,
) -> Result<SkillManifest, String> {
    let skill_id = normalize_skill_id(&skill_id)?;
    with_skill_state(&app, |state| {
        let disabled = &mut state.disabled_skill_ids;
        disabled.retain(|id| id != &skill_id);
        if !enabled {
            disabled.push(skill_id.clone());
        }
        disabled.sort();
        disabled.dedup();
    })?;

    find_skill_manifest(&app, &skill_id)?
        .ok_or_else(|| format!("skill is not installed: {skill_id}"))
}

#[tauri::command]
pub fn open_user_skill_dir(app: AppHandle) -> Result<String, String> {
    let dir = user_skill_root(&app)?;
    fs::create_dir_all(&dir)
        .map_err(|error| format!("failed to create skill dir {}: {error}", dir.display()))?;
    open_directory(&dir)?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn pick_and_install_skill(app: AppHandle) -> Result<SkillManifest, String> {
    let Some(source) = rfd::FileDialog::new()
        .set_title("Import Skill package")
        .add_filter("Skill package", &["zip"])
        .add_filter("Skill manifest", &["json", "md"])
        .pick_file()
    else {
        return Err("cancelled".to_string());
    };
    install_skill_from_picked_path(&app, &source)
}

#[tauri::command]
pub fn delete_user_skill(app: AppHandle, skill_id: String) -> Result<(), String> {
    let skill_id = normalize_skill_id(&skill_id)?;
    let user_root = user_skill_root(&app)?;
    let user_root = ensure_canonical_dir(&user_root)?;
    let target = find_skill_dir_in_root(&user_root, &skill_id, "user")?
        .ok_or_else(|| format!("user skill is not installed: {skill_id}"))?;
    let target = target
        .canonicalize()
        .map_err(|error| format!("failed to resolve skill dir {}: {error}", target.display()))?;
    if !target.starts_with(&user_root) {
        return Err("refusing to delete outside the user skill directory".to_string());
    }
    fs::remove_dir_all(&target)
        .map_err(|error| format!("failed to delete skill {}: {error}", target.display()))?;

    with_skill_state(&app, |state| {
        state.disabled_skill_ids.retain(|id| id != &skill_id);
    })?;
    Ok(())
}

#[tauri::command]
pub fn execute_skill_plan(
    app: AppHandle,
    plan: SkillExecutionPlanRequest,
) -> Result<SkillExecutionResult, String> {
    execute_gongwen_format_plan(&app, plan)
}

fn build_skill_catalog(app: &AppHandle) -> Result<SkillCatalog, String> {
    let mut seen = HashSet::new();
    let mut skills = Vec::new();
    let mut errors = Vec::new();
    let state = load_skill_state(app)?;

    for (source, root) in skill_roots(app) {
        if !root.is_dir() {
            continue;
        }

        let entries = fs::read_dir(&root)
            .map_err(|error| format!("failed to read skill root {}: {error}", root.display()))?;
        for entry in entries {
            let entry = entry.map_err(|error| format!("failed to read skill entry: {error}"))?;
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            match load_manifest_from_dir(&path, &source) {
                Ok(Some(mut manifest)) => {
                    apply_skill_state(&mut manifest, &state);
                    if seen.insert(manifest.id.clone()) {
                        skills.push(manifest);
                    }
                }
                Ok(None) => {}
                Err(error) => {
                    errors.push(SkillLoadError {
                        source: source.clone(),
                        path: path.to_string_lossy().to_string(),
                        message: error,
                    });
                }
            }
        }
    }

    skills.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
    errors.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(SkillCatalog { skills, errors })
}

#[tauri::command]
pub fn get_skill(app: AppHandle, skill_id: String) -> Result<SkillDefinition, String> {
    let requested = skill_id.trim();
    if requested.is_empty() {
        return Err("skill id cannot be empty".to_string());
    }

    let state = load_skill_state(&app)?;
    for (source, root) in skill_roots(&app) {
        if !root.is_dir() {
            continue;
        }

        let entries = fs::read_dir(&root)
            .map_err(|error| format!("failed to read skill root {}: {error}", root.display()))?;
        for entry in entries {
            let entry = entry.map_err(|error| format!("failed to read skill entry: {error}"))?;
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let mut manifest = match load_manifest_from_dir(&path, &source) {
                Ok(Some(manifest)) => manifest,
                Ok(None) => continue,
                Err(error) => {
                    eprintln!("Skipping invalid skill {}: {error}", path.display());
                    continue;
                }
            };
            if manifest.id != requested {
                continue;
            }
            apply_skill_state(&mut manifest, &state);

            let entry_path = safe_entry_path(&path, &manifest.entry)?;
            ensure_file_size(&entry_path, MAX_SKILL_ENTRY_BYTES)?;
            let entry_content = fs::read_to_string(&entry_path).map_err(|error| {
                format!(
                    "failed to read skill entry {}: {error}",
                    entry_path.display()
                )
            })?;

            return Ok(SkillDefinition {
                manifest,
                entry_content,
            });
        }
    }

    Err(format!("skill is not installed: {requested}"))
}

fn find_skill_manifest(app: &AppHandle, skill_id: &str) -> Result<Option<SkillManifest>, String> {
    let state = load_skill_state(app)?;
    for (source, root) in skill_roots(app) {
        if !root.is_dir() {
            continue;
        }
        let Some(path) = find_skill_dir_in_root(&root, skill_id, &source)? else {
            continue;
        };
        let Some(mut manifest) = load_manifest_from_dir(&path, &source)? else {
            continue;
        };
        apply_skill_state(&mut manifest, &state);
        return Ok(Some(manifest));
    }
    Ok(None)
}

fn find_skill_manifest_and_dir(
    app: &AppHandle,
    skill_id: &str,
) -> Result<Option<(SkillManifest, PathBuf)>, String> {
    let state = load_skill_state(app)?;
    for (source, root) in skill_roots(app) {
        if !root.is_dir() {
            continue;
        }
        let Some(path) = find_skill_dir_in_root(&root, skill_id, &source)? else {
            continue;
        };
        let Some(mut manifest) = load_manifest_from_dir(&path, &source)? else {
            continue;
        };
        apply_skill_state(&mut manifest, &state);
        let canonical = path
            .canonicalize()
            .map_err(|error| format!("failed to resolve skill dir {}: {error}", path.display()))?;
        return Ok(Some((manifest, canonical)));
    }
    Ok(None)
}

fn find_skill_dir_in_root(
    root: &Path,
    skill_id: &str,
    source: &str,
) -> Result<Option<PathBuf>, String> {
    if !root.is_dir() {
        return Ok(None);
    }
    let entries = fs::read_dir(root)
        .map_err(|error| format!("failed to read skill root {}: {error}", root.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("failed to read skill entry: {error}"))?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(manifest) = load_manifest_from_dir(&path, source)? else {
            continue;
        };
        if manifest.id == skill_id {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

fn skill_roots(app: &AppHandle) -> Vec<(String, PathBuf)> {
    let mut roots = Vec::new();

    if let Ok(user_root) = user_skill_root(app) {
        roots.push(("user".to_string(), user_root));
    }
    if let Ok(current_dir) = std::env::current_dir() {
        roots.push(("project".to_string(), current_dir.join("skills")));
        if let Some(parent) = current_dir.parent() {
            roots.push(("project".to_string(), parent.join("skills")));
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        roots.push(("resource".to_string(), resource_dir.join("skills")));
    }

    roots
}

fn user_skill_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|data_dir| data_dir.join("skills"))
        .map_err(|error| format!("failed to resolve app data dir: {error}"))
}

fn skill_state_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|data_dir| data_dir.join("skill-state.json"))
        .map_err(|error| format!("failed to resolve app data dir: {error}"))
}

fn load_skill_state(app: &AppHandle) -> Result<SkillRegistryState, String> {
    let path = skill_state_path(app)?;
    if !path.is_file() {
        return Ok(SkillRegistryState::default());
    }
    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    serde_json::from_str::<SkillRegistryState>(&raw)
        .map_err(|error| format!("failed to parse {}: {error}", path.display()))
}

/// Atomic write (sibling temp file + rename) so a crash mid-write cannot
/// leave a truncated state file. Does not take the RMW lock — callers that
/// need load → mutate → save atomicity should use [`with_skill_state`].
fn write_skill_state_atomic(app: &AppHandle, state: &SkillRegistryState) -> Result<(), String> {
    let path = skill_state_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    }
    let raw = serde_json::to_string_pretty(state)
        .map_err(|error| format!("failed to serialize skill state: {error}"))?;
    let temp_path = path.with_extension("json.tmp");
    fs::write(&temp_path, &raw)
        .map_err(|error| format!("failed to write {}: {error}", temp_path.display()))?;
    fs::rename(&temp_path, &path)
        .map_err(|error| format!("failed to persist {}: {error}", path.display()))?;
    Ok(())
}

/// Run load → mutate → save under the process-wide lock so concurrent
/// commands cannot interleave and lose updates.
fn with_skill_state<R>(
    app: &AppHandle,
    mutator: impl FnOnce(&mut SkillRegistryState) -> R,
) -> Result<R, String> {
    let _guard = skill_state_lock()
        .lock()
        .map_err(|error| format!("skill state is busy and could not be locked: {error}"))?;
    let mut state = load_skill_state(app)?;
    let result = mutator(&mut state);
    write_skill_state_atomic(app, &state)?;
    Ok(result)
}

/// Serializes read-modify-write on skill-state.json within this process so
/// concurrent commands (e.g. toggling two skills in quick succession) cannot
/// lose updates by interleaving load → mutate → save.
fn skill_state_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn apply_skill_state(manifest: &mut SkillManifest, state: &SkillRegistryState) {
    if state.disabled_skill_ids.iter().any(|id| id == &manifest.id) {
        manifest.enabled = false;
    }
}

fn load_manifest_from_dir(skill_dir: &Path, source: &str) -> Result<Option<SkillManifest>, String> {
    let manifest_path = skill_dir.join("skill.json");
    let mut manifest = if manifest_path.is_file() {
        ensure_file_size(&manifest_path, MAX_SKILL_MANIFEST_BYTES)?;
        let raw = fs::read_to_string(&manifest_path)
            .map_err(|error| format!("failed to read {}: {error}", manifest_path.display()))?;
        serde_json::from_str::<SkillManifest>(&raw)
            .map_err(|error| format!("failed to parse {}: {error}", manifest_path.display()))?
    } else {
        let entry_path = skill_dir.join(default_entry());
        if !entry_path.is_file() {
            return Ok(None);
        }
        load_manifest_from_skill_md(&entry_path)?
            .ok_or_else(|| format!("SKILL.md is missing frontmatter: {}", entry_path.display()))?
    };

    finalize_manifest(skill_dir, source, &mut manifest)?;
    Ok(Some(manifest))
}

fn load_manifest_from_skill_md(entry_path: &Path) -> Result<Option<SkillManifest>, String> {
    ensure_file_size(entry_path, MAX_SKILL_ENTRY_BYTES)?;
    let raw = fs::read_to_string(entry_path)
        .map_err(|error| format!("failed to read {}: {error}", entry_path.display()))?;
    let Some(frontmatter) = extract_skill_frontmatter(&raw) else {
        return Ok(None);
    };

    let fields = parse_simple_yaml_frontmatter(&frontmatter);
    let name = fields
        .iter()
        .find(|(key, _)| key == "name")
        .map(|(_, value)| value.trim().to_string())
        .unwrap_or_default();
    let description = fields
        .iter()
        .find(|(key, _)| key == "description")
        .map(|(_, value)| value.trim().to_string())
        .unwrap_or_default();
    if name.is_empty() || description.is_empty() {
        return Err(format!(
            "standard SKILL.md frontmatter requires name and description: {}",
            entry_path.display()
        ));
    }

    let version = fields
        .iter()
        .find(|(key, _)| key == "version")
        .map(|(_, value)| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let runtime = fields
        .iter()
        .find(|(key, _)| key == "runtime")
        .map(|(_, value)| value.trim().to_string())
        .unwrap_or_else(default_runtime);

    // Resolve the skill id. An explicit `id` frontmatter field wins; otherwise
    // we derive a slug from `name`. A Chinese-only name cannot become a valid
    // id (normalize_skill_id only allows ASCII), so surface a clear error
    // asking the author to add an `id` field instead of failing opaquely.
    let explicit_id = fields
        .iter()
        .find(|(key, _)| key == "id")
        .map(|(_, value)| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let id = explicit_id
        .clone()
        .unwrap_or_else(|| slugify_skill_id(&name));
    if normalize_skill_id(&id).is_err() {
        return Err(format!(
            "SKILL.md name {:?} cannot be used as a skill id (only ASCII letters, digits, '-', '_', '.' are allowed). Add an `id` field to the frontmatter: {}",
            name, entry_path.display()
        ));
    }

    let mut keywords = extract_standard_skill_terms(&description);
    keywords.push(name.clone());
    let triggers = keywords.clone();

    Ok(Some(SkillManifest {
        id,
        name: fields
            .iter()
            .find(|(key, _)| key == "title")
            .map(|(_, value)| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| name.clone()),
        description,
        version,
        keywords,
        triggers,
        entry: default_entry(),
        runtime,
        enabled: true,
        permissions: None,
        source: None,
        source_path: None,
        can_delete: false,
        can_toggle: true,
    }))
}

fn finalize_manifest(
    skill_dir: &Path,
    source: &str,
    manifest: &mut SkillManifest,
) -> Result<(), String> {
    manifest.id = manifest.id.trim().to_string();
    normalize_skill_id(&manifest.id)?;
    manifest.name = manifest.name.trim().to_string();
    manifest.description = manifest.description.trim().to_string();
    manifest.entry = manifest.entry.trim().to_string();
    manifest.runtime = manifest.runtime.trim().to_ascii_lowercase();
    manifest.keywords = clean_list(std::mem::take(&mut manifest.keywords));
    manifest.triggers = clean_list(std::mem::take(&mut manifest.triggers));

    if manifest.id.is_empty() {
        return Err(format!("skill id cannot be empty: {}", skill_dir.display()));
    }
    if manifest.name.is_empty() {
        return Err(format!(
            "skill name cannot be empty: {}",
            skill_dir.display()
        ));
    }
    if manifest.description.is_empty() {
        return Err(format!(
            "skill description cannot be empty: {}",
            skill_dir.display()
        ));
    }
    if manifest.entry.is_empty() {
        manifest.entry = default_entry();
    }

    safe_entry_path(skill_dir, &manifest.entry)?;
    manifest.source = Some(source.to_string());
    manifest.source_path = Some(skill_dir.to_string_lossy().to_string());
    manifest.can_delete = source == "user";
    manifest.can_toggle = true;
    Ok(())
}

fn extract_skill_frontmatter(raw: &str) -> Option<String> {
    let raw = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let mut lines = raw.lines();
    let first = lines.next()?;
    if first.trim() != "---" {
        return None;
    }
    let mut frontmatter = Vec::new();
    for line in lines {
        if line.trim() == "---" {
            return Some(frontmatter.join("\n"));
        }
        frontmatter.push(line);
    }
    None
}

fn parse_simple_yaml_frontmatter(frontmatter: &str) -> Vec<(String, String)> {
    let lines: Vec<_> = frontmatter.lines().collect();
    let mut fields = Vec::new();
    let mut index = 0;

    while index < lines.len() {
        let line = lines[index];
        let trimmed = line.trim();
        if trimmed.is_empty()
            || trimmed.starts_with('#')
            || line.starts_with(' ')
            || line.starts_with('\t')
        {
            index += 1;
            continue;
        }

        let Some((key, value)) = trimmed.split_once(':') else {
            index += 1;
            continue;
        };
        let key = key.trim().to_ascii_lowercase();
        let value = value.trim();

        if is_yaml_block_scalar(value) {
            let folded = value.starts_with('>');
            let mut block = Vec::new();
            index += 1;
            while index < lines.len() {
                let line = lines[index];
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    block.push(String::new());
                    index += 1;
                    continue;
                }
                if !line.starts_with(' ') && !line.starts_with('\t') {
                    break;
                }
                block.push(trimmed.to_string());
                index += 1;
            }
            let joined = if folded {
                block
                    .into_iter()
                    .filter(|value| !value.is_empty())
                    .collect::<Vec<_>>()
                    .join(" ")
            } else {
                block.join("\n")
            };
            fields.push((key, joined));
            continue;
        }

        fields.push((key, unquote_yaml_scalar(value).to_string()));
        index += 1;
    }

    fields
}

fn is_yaml_block_scalar(value: &str) -> bool {
    matches!(value, "|" | ">" | "|-" | ">-" | "|+" | ">+")
}

fn unquote_yaml_scalar(value: &str) -> &str {
    if value.len() >= 2 {
        let bytes = value.as_bytes();
        if (bytes[0] == b'"' && bytes[value.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[value.len() - 1] == b'\'')
        {
            return &value[1..value.len() - 1];
        }
    }
    value
}

fn extract_standard_skill_terms(description: &str) -> Vec<String> {
    clean_list(
        description
            .split(|ch: char| {
                ch.is_whitespace()
                    || matches!(
                        ch,
                        ',' | ';'
                            | ':'
                            | '，'
                            | '、'
                            | '；'
                            | '：'
                            | '。'
                            | '（'
                            | '）'
                            | '('
                            | ')'
                            | '"'
                            | '“'
                            | '”'
                    )
            })
            .map(|term| term.trim_matches(|ch: char| ch == '.' || ch == '。' || ch == '，'))
            .filter(|term| term.chars().count() >= 2 && term.chars().count() <= 48)
            .map(str::to_string)
            .collect(),
    )
}

fn clean_list(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .filter(|value| seen.insert(value.to_ascii_lowercase()))
        .collect()
}

fn normalize_skill_id(value: &str) -> Result<String, String> {
    let normalized = value.trim().to_string();
    if normalized.is_empty() {
        return Err("skill id cannot be empty".to_string());
    }
    if normalized.len() > 96
        || !normalized
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.')
    {
        return Err(format!("invalid skill id: {normalized}"));
    }
    Ok(normalized)
}

/// Best-effort slug from a free-form name: keep ASCII alphanumerics and the
/// id punctuation set, replace other runs (spaces, CJK, punctuation) with `-`.
/// May return an empty string for a name with no ASCII content, in which case
/// the caller surfaces a clear "add an `id` field" error.
fn slugify_skill_id(name: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = true; // suppress leading dashes
    for ch in name.trim().chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '.' {
            out.push(ch);
            prev_dash = false;
        } else {
            if !prev_dash {
                out.push('-');
                prev_dash = true;
            }
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out
}

fn ensure_file_size(path: &Path, max_bytes: u64) -> Result<(), String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("failed to read metadata {}: {error}", path.display()))?;
    if metadata.len() > max_bytes {
        return Err(format!(
            "file is too large: {} ({} bytes, limit {} bytes)",
            path.display(),
            metadata.len(),
            max_bytes
        ));
    }
    Ok(())
}

fn safe_entry_path(skill_dir: &Path, entry: &str) -> Result<PathBuf, String> {
    let relative = Path::new(entry);
    if relative.is_absolute() {
        return Err("skill entry must be relative".to_string());
    }
    if relative.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err("skill entry cannot leave the skill directory".to_string());
    }

    let root = skill_dir.canonicalize().map_err(|error| {
        format!(
            "failed to resolve skill dir {}: {error}",
            skill_dir.display()
        )
    })?;
    let entry_path = skill_dir.join(relative);
    let canonical_entry = entry_path.canonicalize().map_err(|error| {
        format!(
            "failed to resolve skill entry {}: {error}",
            entry_path.display()
        )
    })?;
    if !canonical_entry.starts_with(&root) {
        return Err("skill entry cannot leave the skill directory".to_string());
    }

    Ok(canonical_entry)
}

fn execute_gongwen_format_plan(
    app: &AppHandle,
    plan: SkillExecutionPlanRequest,
) -> Result<SkillExecutionResult, String> {
    let skill_id = normalize_skill_id(&plan.skill_id)?;
    if plan.input_content.len() > MAX_SKILL_EXECUTION_INPUT_BYTES {
        return Err(format!(
            "Skill input is too large (limit {} bytes)",
            MAX_SKILL_EXECUTION_INPUT_BYTES
        ));
    }

    let (manifest, skill_dir) = find_skill_manifest_and_dir(app, &skill_id)?
        .ok_or_else(|| format!("skill is not installed: {skill_id}"))?;
    if !manifest.enabled {
        return Err(format!("skill is disabled: {skill_id}"));
    }
    // Only skills that explicitly declare a script runtime may run local code.
    // Instruction/workflow skills never execute scripts, regardless of what
    // their SKILL.md prose mentions.
    if manifest.runtime != "script" {
        return Err(format!(
            "skill runtime '{}' does not allow local script execution",
            manifest.runtime
        ));
    }

    let script_path = skill_dir.join("scripts").join("gongwen_format.py");
    let script_path = script_path.canonicalize().map_err(|error| {
        format!(
            "failed to resolve Skill script {}: {error}",
            script_path.display()
        )
    })?;
    if !script_path.starts_with(&skill_dir) || !script_path.is_file() {
        return Err("Skill execution is limited to scripts/gongwen_format.py".to_string());
    }

    let output_format = sanitize_output_format(&plan.output_format)?;
    let input_file_name = sanitize_input_file_name(&plan.input_file_name)?;
    let output_file_name = sanitize_output_file_name(&plan.output_file_name, output_format)?;
    let title = clean_parameter_value(
        plan.parameters
            .get("title")
            .map(String::as_str)
            .unwrap_or(&manifest.name),
    )?;

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve app data dir: {error}"))?;
    let run_dir = data_dir.join("skill-runs").join(sanitize_run_id(&plan.id));
    fs::create_dir_all(&run_dir)
        .map_err(|error| format!("failed to create run dir {}: {error}", run_dir.display()))?;
    // Best-effort: sweep stale run directories so app-data does not grow
    // unbounded over time. Never fatal if this fails.
    cleanup_stale_skill_runs(&data_dir.join("skill-runs"));
    let input_path = run_dir.join(input_file_name);
    fs::write(&input_path, &plan.input_content).map_err(|error| {
        format!(
            "failed to write Skill input {}: {error}",
            input_path.display()
        )
    })?;

    let export_dir = data_dir.join("exports");
    fs::create_dir_all(&export_dir).map_err(|error| {
        format!(
            "failed to create Skill export dir {}: {error}",
            export_dir.display()
        )
    })?;
    let output_path = unique_export_path(&export_dir, &output_file_name)?;

    let mut args = vec![
        script_path.to_string_lossy().to_string(),
        format!("--title={}", title),
        format!("--input={}", input_path.to_string_lossy()),
        format!("--output={}", output_path.to_string_lossy()),
        format!("--format={}", output_format),
    ];
    append_allowed_gongwen_parameters(&mut args, &plan.parameters)?;

    let (python, output) = run_python_script(&args, &skill_dir)?;
    if !output.status.success() {
        return Err(format!(
            "Skill script failed: {}",
            command_output_text(&output)
        ));
    }
    if !output_path.is_file() {
        return Err(format!(
            "Skill script completed but did not create output file: {}",
            output_path.display()
        ));
    }

    let file_name = output_path
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or(&output_file_name)
        .to_string();
    Ok(SkillExecutionResult {
        path: output_path.to_string_lossy().to_string(),
        file_name,
        input_path: input_path.to_string_lossy().to_string(),
        command_preview: build_command_preview(&python, &args, &skill_dir),
        stdout: optional_output_text(&output.stdout),
        stderr: optional_output_text(&output.stderr),
    })
}

fn run_python_script(
    args: &[String],
    cwd: &Path,
) -> Result<(String, std::process::Output), String> {
    // Track whether any interpreter actually started, so we can tell the user
    // "Python is not installed" apart from "the script ran and failed".
    let mut interpreter_seen = false;
    let mut script_failure = None;
    let mut spawn_error = None;

    for python in python_candidates() {
        let mut command = std::process::Command::new(python);
        command
            .args(args)
            .current_dir(cwd)
            .env("PYTHONIOENCODING", "utf-8")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        match run_command_with_timeout(command, SKILL_EXECUTION_TIMEOUT) {
            Ok(output) if output.status.success() => return Ok((python.to_string(), output)),
            Ok(output) => {
                interpreter_seen = true;
                script_failure = Some(format!(
                    "{} exited with {}: {}",
                    python,
                    output.status,
                    command_output_text(&output)
                ));
            }
            Err(RunCommandError::Spawn(error)) => {
                spawn_error = Some(error);
                continue;
            }
            Err(RunCommandError::Timeout) => {
                return Err(format!(
                    "Skill script timed out after {} seconds",
                    SKILL_EXECUTION_TIMEOUT.as_secs()
                ));
            }
            Err(RunCommandError::Io(error)) => {
                return Err(format!("Skill script IO error: {error}"));
            }
        }
    }

    if let Some(failure) = script_failure {
        return Err(failure);
    }
    if interpreter_seen {
        return Err("Skill script failed to run".to_string());
    }
    Err(format!(
        "no Python interpreter is available (tried {}). Install Python 3 or add it to PATH. Last spawn error: {}",
        python_candidates().join(", "),
        spawn_error.unwrap_or_else(|| "unknown".to_string())
    ))
}

enum RunCommandError {
    Spawn(String),
    Io(String),
    Timeout,
}

fn run_command_with_timeout(
    mut command: std::process::Command,
    timeout: Duration,
) -> Result<std::process::Output, RunCommandError> {
    let mut child = command.spawn().map_err(|error| {
        RunCommandError::Spawn(format!("failed to start Skill script: {error}"))
    })?;

    // Drain stdout/stderr on background threads. If we only read the pipes
    // after the child exits, a script that logs more than the OS pipe buffer
    // (~64 KB) would block on write, never exit, and we would report a
    // misleading timeout.
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| RunCommandError::Io("stdout pipe was not captured".to_string()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| RunCommandError::Io("stderr pipe was not captured".to_string()))?;

    let stdout_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        // Cap at 8 MB so a runaway script cannot exhaust memory.
        let _ = stdout.take(8 * 1024 * 1024).read_to_end(&mut buf);
        buf
    });
    let stderr_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr.take(8 * 1024 * 1024).read_to_end(&mut buf);
        buf
    });

    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(error) => {
                let _ = stdout_handle.join();
                let _ = stderr_handle.join();
                return Err(RunCommandError::Io(format!(
                    "failed to wait for Skill script: {error}"
                )));
            }
        }
        if start.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_handle.join();
            let _ = stderr_handle.join();
            return Err(RunCommandError::Timeout);
        }
        std::thread::sleep(Duration::from_millis(100));
    };

    let stdout_buf = stdout_handle
        .join()
        .map_err(|_| RunCommandError::Io("stdout drain thread panicked".to_string()))?;
    let stderr_buf = stderr_handle
        .join()
        .map_err(|_| RunCommandError::Io("stderr drain thread panicked".to_string()))?;

    Ok(std::process::Output {
        status,
        stdout: stdout_buf,
        stderr: stderr_buf,
    })
}

#[cfg(target_os = "windows")]
fn python_candidates() -> &'static [&'static str] {
    &["py", "python3", "python"]
}

#[cfg(not(target_os = "windows"))]
fn python_candidates() -> &'static [&'static str] {
    &["python3", "python"]
}

fn build_command_preview(python: &str, args: &[String], skill_dir: &Path) -> Vec<String> {
    let mut preview = vec![python.to_string()];
    preview.extend(args.iter().map(|arg| {
        Path::new(arg)
            .strip_prefix(skill_dir)
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_else(|_| arg.clone())
    }));
    preview
}

fn append_allowed_gongwen_parameters(
    args: &mut Vec<String>,
    parameters: &BTreeMap<String, String>,
) -> Result<(), String> {
    for (key, value) in parameters {
        if key == "title" {
            continue;
        }
        let Some(flag) = allowed_gongwen_parameter_flag(key) else {
            continue;
        };
        let value = clean_parameter_value(value)?;
        if value.is_empty() {
            continue;
        }
        // Use --flag=value so a value that happens to start with '-' cannot be
        // mis-parsed by argparse as an option.
        args.push(format!("{flag}={value}"));
    }
    Ok(())
}

fn allowed_gongwen_parameter_flag(key: &str) -> Option<&'static str> {
    match key {
        "redhead" => Some("--redhead"),
        "docNumber" | "doc-number" => Some("--doc-number"),
        "author" => Some("--author"),
        "date" => Some("--date"),
        "printAuthor" | "print-author" => Some("--print-author"),
        "printDate" | "print-date" => Some("--print-date"),
        "cc" => Some("--cc"),
        "copies" => Some("--copies"),
        "secretLevel" | "secret-level" => Some("--secret-level"),
        "urgency" => Some("--urgency"),
        "signer" => Some("--signer"),
        "recipient" => Some("--recipient"),
        "notes" => Some("--notes"),
        _ => None,
    }
}

fn clean_parameter_value(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.chars().any(|ch| ch == '\0') {
        return Err("Skill parameter contains an invalid character".to_string());
    }
    if value.chars().count() > 500 {
        return Err("Skill parameter is too long".to_string());
    }
    Ok(value.to_string())
}

fn sanitize_output_format(value: &str) -> Result<&'static str, String> {
    match value
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase()
        .as_str()
    {
        "docx" => Ok("docx"),
        "pdf" => Ok("pdf"),
        _ => Err("Skill output format must be docx or pdf".to_string()),
    }
}

fn sanitize_input_file_name(value: &str) -> Result<String, String> {
    let file_name = sanitize_file_name(value, "skill-input.md");
    let extension = Path::new(&file_name)
        .extension()
        .and_then(OsStr::to_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if extension != "md" && extension != "txt" {
        return Err("Skill input file must be .md or .txt".to_string());
    }
    Ok(file_name)
}

fn sanitize_output_file_name(value: &str, output_format: &str) -> Result<String, String> {
    let mut file_name = sanitize_file_name(value, "skill-output.docx");
    let extension = Path::new(&file_name)
        .extension()
        .and_then(OsStr::to_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if extension != output_format {
        let stem = Path::new(&file_name)
            .file_stem()
            .and_then(OsStr::to_str)
            .unwrap_or("skill-output");
        file_name = format!("{stem}.{output_format}");
    }
    Ok(file_name)
}

fn sanitize_run_id(value: &str) -> String {
    let cleaned = value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .take(96)
        .collect::<String>();
    if cleaned.is_empty() {
        timestamp_text()
    } else {
        cleaned
    }
}

fn sanitize_file_name(value: &str, fallback: &str) -> String {
    let cleaned = value
        .trim()
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '\0'..='\u{1f}' => '_',
            _ => ch,
        })
        .collect::<String>()
        .trim_matches(['.', ' '])
        .chars()
        .take(96)
        .collect::<String>();
    if cleaned.is_empty() {
        fallback.to_string()
    } else {
        cleaned
    }
}

fn unique_export_path(export_dir: &Path, file_name: &str) -> Result<PathBuf, String> {
    let timestamp = timestamp_text();
    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(OsStr::to_str)
        .unwrap_or("skill-output");
    let extension = path.extension().and_then(OsStr::to_str).unwrap_or("docx");
    let candidate = export_dir.join(format!("{stem}-{timestamp}.{extension}"));
    if candidate.exists() {
        return Err(format!(
            "export file already exists: {}",
            candidate.display()
        ));
    }
    Ok(candidate)
}

fn timestamp_text() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    millis.to_string()
}

/// Remove skill run directories older than the cutoff. Best-effort: any error
/// (busy dir, permission) is logged to stderr and skipped so a clean-up never
/// breaks an in-flight execution.
fn cleanup_stale_skill_runs(runs_root: &Path) {
    const MAX_AGE: Duration = Duration::from_secs(60 * 60 * 24); // 24h
    let cutoff = SystemTime::now()
        .checked_sub(MAX_AGE)
        .unwrap_or(SystemTime::UNIX_EPOCH);

    let entries = match fs::read_dir(runs_root) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let modified = entry.metadata().and_then(|meta| meta.modified());
        let is_stale = match modified {
            Ok(time) => time < cutoff,
            Err(_) => false,
        };
        if !is_stale {
            continue;
        }
        if let Err(error) = fs::remove_dir_all(&path) {
            eprintln!(
                "skill cleanup: failed to remove stale run dir {}: {error}",
                path.display()
            );
        }
    }
}

fn optional_output_text(bytes: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(bytes).trim().to_string();
    if text.is_empty() {
        None
    } else if text.chars().count() > 2000 {
        Some(text.chars().take(2000).collect())
    } else {
        Some(text)
    }
}

fn install_skill_from_picked_path(
    app: &AppHandle,
    source_path: &Path,
) -> Result<SkillManifest, String> {
    let source = source_path.canonicalize().map_err(|error| {
        format!(
            "failed to resolve source skill package {}: {error}",
            source_path.display()
        )
    })?;

    if source.is_dir() {
        return install_skill_from_source(app, &source);
    }
    if !source.is_file() {
        return Err(format!(
            "source is not a file or directory: {}",
            source.display()
        ));
    }

    let extension = source
        .extension()
        .and_then(OsStr::to_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if extension == "zip" {
        return install_skill_from_zip(app, &source);
    }

    let file_name = source
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or_default();
    if file_name.eq_ignore_ascii_case("skill.json") || file_name.eq_ignore_ascii_case("SKILL.md") {
        let parent = source.parent().ok_or_else(|| {
            format!(
                "Skill manifest has no parent directory: {}",
                source.display()
            )
        })?;
        return install_skill_from_source(app, parent);
    }

    Err("please select a Skill .zip package, skill.json, or SKILL.md".to_string())
}

fn install_skill_from_zip(app: &AppHandle, zip_path: &Path) -> Result<SkillManifest, String> {
    ensure_file_size(zip_path, MAX_SKILL_INSTALL_BYTES)?;
    let staging_dir = create_skill_extract_dir()?;
    let result = (|| {
        extract_skill_zip(zip_path, &staging_dir)?;
        let skill_dir = find_extracted_skill_dir(&staging_dir)?;
        install_skill_from_source(app, &skill_dir)
    })();

    if let Err(error) = fs::remove_dir_all(&staging_dir) {
        eprintln!(
            "Failed to remove temporary skill import directory {}: {error}",
            staging_dir.display()
        );
    }

    result
}

fn create_skill_extract_dir() -> Result<PathBuf, String> {
    let base = std::env::temp_dir().join("nova-skill-import");
    fs::create_dir_all(&base)
        .map_err(|error| format!("failed to create {}: {error}", base.display()))?;

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("system clock error: {error}"))?
        .as_nanos();
    let process_id = std::process::id();

    for attempt in 0..100 {
        let path = base.join(format!("{process_id}-{timestamp}-{attempt}"));
        match fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("failed to create {}: {error}", path.display())),
        }
    }

    Err(format!(
        "failed to create a unique temporary directory under {}",
        base.display()
    ))
}

fn extract_skill_zip(zip_path: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target)
        .map_err(|error| format!("failed to create {}: {error}", target.display()))?;

    let output = run_zip_extract_command(zip_path, target)?;
    if !output.status.success() {
        return Err(format!(
            "failed to extract zip package {}: {}",
            zip_path.display(),
            command_output_text(&output)
        ));
    }

    validate_extracted_skill_tree(target)
}

#[cfg(target_os = "windows")]
fn run_zip_extract_command(zip_path: &Path, target: &Path) -> Result<std::process::Output, String> {
    std::process::Command::new("powershell")
        .env("NOVA_SKILL_ZIP_PATH", zip_path)
        .env("NOVA_SKILL_EXTRACT_DIR", target)
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-Command")
        .arg("Expand-Archive -LiteralPath $env:NOVA_SKILL_ZIP_PATH -DestinationPath $env:NOVA_SKILL_EXTRACT_DIR -Force")
        .output()
        .map_err(|error| format!("failed to start PowerShell zip extractor: {error}"))
}

#[cfg(target_os = "macos")]
fn run_zip_extract_command(zip_path: &Path, target: &Path) -> Result<std::process::Output, String> {
    std::process::Command::new("ditto")
        .arg("-x")
        .arg("-k")
        .arg(zip_path)
        .arg(target)
        .output()
        .map_err(|error| format!("failed to start ditto zip extractor: {error}"))
}

#[cfg(target_os = "linux")]
fn run_zip_extract_command(zip_path: &Path, target: &Path) -> Result<std::process::Output, String> {
    std::process::Command::new("unzip")
        .arg("-q")
        .arg(zip_path)
        .arg("-d")
        .arg(target)
        .output()
        .map_err(|error| format!("failed to start unzip extractor: {error}"))
}

fn command_output_text(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !stderr.is_empty() {
        return stderr;
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        format!("exit status {}", output.status)
    } else {
        stdout
    }
}

fn validate_extracted_skill_tree(root: &Path) -> Result<(), String> {
    let root = root
        .canonicalize()
        .map_err(|error| format!("failed to resolve {}: {error}", root.display()))?;
    let mut total_bytes = 0_u64;
    validate_extracted_skill_entry(&root, &root, &mut total_bytes)
}

fn validate_extracted_skill_entry(
    root: &Path,
    path: &Path,
    total_bytes: &mut u64,
) -> Result<(), String> {
    let entries = fs::read_dir(path)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("failed to read directory entry: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("failed to read file type: {error}"))?;
        if file_type.is_symlink() {
            return Err(format!(
                "symlinks are not allowed in skills: {}",
                entry.path().display()
            ));
        }

        let entry_path = entry.path();
        let canonical_entry = entry_path.canonicalize().map_err(|error| {
            format!(
                "failed to resolve extracted file {}: {error}",
                entry_path.display()
            )
        })?;
        if !canonical_entry.starts_with(root) {
            return Err(format!(
                "zip package extracted outside the temporary directory: {}",
                entry_path.display()
            ));
        }

        if file_type.is_dir() {
            validate_extracted_skill_entry(root, &entry_path, total_bytes)?;
        } else if file_type.is_file() {
            let size = entry
                .metadata()
                .map_err(|error| {
                    format!("failed to read metadata {}: {error}", entry_path.display())
                })?
                .len();
            *total_bytes = total_bytes.saturating_add(size);
            if *total_bytes > MAX_SKILL_INSTALL_BYTES {
                return Err(format!(
                    "skill package is too large (limit {} bytes)",
                    MAX_SKILL_INSTALL_BYTES
                ));
            }
        }
    }

    Ok(())
}

fn find_extracted_skill_dir(root: &Path) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    collect_extracted_skill_dirs(root, 0, &mut candidates)?;
    candidates.sort();
    candidates.dedup();

    match candidates.len() {
        0 => Err("skill.json was not found in the zip package".to_string()),
        1 => Ok(candidates.remove(0)),
        _ => Err(
            "zip package contains multiple Skill manifests; package one Skill at a time"
                .to_string(),
        ),
    }
}

fn collect_extracted_skill_dirs(
    dir: &Path,
    depth: usize,
    candidates: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if load_manifest_from_dir(dir, "import")?.is_some() {
        candidates.push(dir.to_path_buf());
        return Ok(());
    }
    if depth >= MAX_SKILL_ZIP_SEARCH_DEPTH {
        return Ok(());
    }

    let entries =
        fs::read_dir(dir).map_err(|error| format!("failed to read {}: {error}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("failed to read directory entry: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("failed to read file type: {error}"))?;
        if file_type.is_symlink() {
            return Err(format!(
                "symlinks are not allowed in skills: {}",
                entry.path().display()
            ));
        }
        if !file_type.is_dir() || should_skip_skill_name(&entry.file_name()) {
            continue;
        }
        collect_extracted_skill_dirs(&entry.path(), depth + 1, candidates)?;
    }

    Ok(())
}

fn install_skill_from_source(app: &AppHandle, source_path: &Path) -> Result<SkillManifest, String> {
    let source = source_path.canonicalize().map_err(|error| {
        format!(
            "failed to resolve source skill dir {}: {error}",
            source_path.display()
        )
    })?;
    if !source.is_dir() {
        return Err(format!("source is not a directory: {}", source.display()));
    }

    let Some(manifest) = load_manifest_from_dir(&source, "import")? else {
        return Err(format!("skill.json was not found in {}", source.display()));
    };
    if find_skill_manifest(app, &manifest.id)?.is_some() {
        return Err(format!("skill id already exists: {}", manifest.id));
    }

    let root = user_skill_root(app)?;
    fs::create_dir_all(&root)
        .map_err(|error| format!("failed to create skill root {}: {error}", root.display()))?;
    let target = root.join(&manifest.id);
    if target.exists() {
        return Err(format!(
            "target skill directory already exists: {}",
            target.display()
        ));
    }

    let mut total_bytes = 0_u64;
    copy_skill_dir(&source, &target, &mut total_bytes)?;

    let mut installed = load_manifest_from_dir(&target, "user")?
        .ok_or_else(|| format!("installed skill is invalid: {}", target.display()))?;
    let state = load_skill_state(app)?;
    apply_skill_state(&mut installed, &state);
    Ok(installed)
}

fn should_skip_skill_name(name: &OsStr) -> bool {
    name == ".git" || name == "node_modules" || name == "target" || name == "__MACOSX"
}

fn copy_skill_dir(source: &Path, target: &Path, total_bytes: &mut u64) -> Result<(), String> {
    fs::create_dir_all(target)
        .map_err(|error| format!("failed to create {}: {error}", target.display()))?;
    let entries = fs::read_dir(source)
        .map_err(|error| format!("failed to read {}: {error}", source.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("failed to read directory entry: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("failed to read file type: {error}"))?;
        if file_type.is_symlink() {
            return Err(format!(
                "symlinks are not allowed in skills: {}",
                entry.path().display()
            ));
        }

        let name = entry.file_name();
        if should_skip_skill_name(&name) {
            continue;
        }
        let source_path = entry.path();
        let target_path = target.join(name);
        if file_type.is_dir() {
            copy_skill_dir(&source_path, &target_path, total_bytes)?;
        } else if file_type.is_file() {
            let size = entry
                .metadata()
                .map_err(|error| {
                    format!("failed to read metadata {}: {error}", source_path.display())
                })?
                .len();
            *total_bytes = total_bytes.saturating_add(size);
            if *total_bytes > MAX_SKILL_INSTALL_BYTES {
                return Err(format!(
                    "skill package is too large (limit {} bytes)",
                    MAX_SKILL_INSTALL_BYTES
                ));
            }
            fs::copy(&source_path, &target_path).map_err(|error| {
                format!(
                    "failed to copy {} to {}: {error}",
                    source_path.display(),
                    target_path.display()
                )
            })?;
        }
    }
    Ok(())
}

fn ensure_canonical_dir(path: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(path)
        .map_err(|error| format!("failed to create {}: {error}", path.display()))?;
    path.canonicalize()
        .map_err(|error| format!("failed to resolve {}: {error}", path.display()))
}

fn open_directory(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(path)
            .spawn()
            .map_err(|error| format!("failed to open directory {}: {error}", path.display()))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|error| format!("failed to open directory {}: {error}", path.display()))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|error| format!("failed to open directory {}: {error}", path.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_dir(label: &str) -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be valid")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "nova-skill-registry-test-{label}-{}-{timestamp}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("test dir should be created");
        dir
    }

    fn write_test_skill(dir: &Path, id: &str) {
        fs::create_dir_all(dir).expect("skill dir should be created");
        fs::write(
            dir.join("skill.json"),
            format!(
                r#"{{
  "id": "{id}",
  "name": "Test Skill",
  "description": "A test skill",
  "entry": "SKILL.md"
}}"#
            ),
        )
        .expect("skill manifest should be written");
        fs::write(dir.join("SKILL.md"), "# Test Skill\n").expect("entry should be written");
    }

    fn write_standard_skill(dir: &Path, id: &str) {
        fs::create_dir_all(dir).expect("skill dir should be created");
        fs::write(
            dir.join("SKILL.md"),
            format!(
                r#"---
name: {id}
description: "公文排版、标准格式、生成docx、红头文件、GB/T 9704"
---

# 党政机关公文标准排版
"#
            ),
        )
        .expect("standard skill entry should be written");
    }

    #[test]
    fn safe_entry_rejects_parent_dir() {
        let dir = std::env::current_dir().expect("cwd should be available");
        assert!(safe_entry_path(&dir, "../SKILL.md").is_err());
    }

    #[test]
    fn clean_list_deduplicates_case_insensitively() {
        assert_eq!(
            clean_list(vec![
                "report".to_string(),
                " Report ".to_string(),
                "".to_string(),
                "alert".to_string()
            ]),
            vec!["report".to_string(), "alert".to_string()]
        );
    }

    #[test]
    fn extracted_skill_dir_supports_wrapper_folder() {
        let root = create_test_dir("wrapper");
        let wrapped = root.join("wrapped-skill");
        write_test_skill(&wrapped, "wrapped-skill");

        let found = find_extracted_skill_dir(&root).expect("wrapped skill should be found");
        assert_eq!(found, wrapped);

        fs::remove_dir_all(root).expect("test dir should be removed");
    }

    #[test]
    fn extracted_skill_dir_rejects_multiple_manifests() {
        let root = create_test_dir("multiple");
        write_test_skill(&root.join("one"), "one");
        write_test_skill(&root.join("two"), "two");

        let error = find_extracted_skill_dir(&root).expect_err("multiple skills should fail");
        assert!(error.contains("multiple Skill manifests"));

        fs::remove_dir_all(root).expect("test dir should be removed");
    }

    #[test]
    fn standard_skill_md_frontmatter_loads_manifest() {
        let root = create_test_dir("standard-frontmatter");
        write_standard_skill(&root, "gongwenformat-pro");

        let manifest = load_manifest_from_dir(&root, "import")
            .expect("standard skill should parse")
            .expect("manifest should exist");
        assert_eq!(manifest.id, "gongwenformat-pro");
        assert_eq!(manifest.entry, "SKILL.md");
        assert!(manifest.keywords.iter().any(|term| term == "公文排版"));
        assert!(manifest.triggers.iter().any(|term| term == "生成docx"));

        fs::remove_dir_all(root).expect("test dir should be removed");
    }

    #[test]
    fn standard_skill_md_supports_folded_description() {
        let root = create_test_dir("standard-folded-frontmatter");
        fs::write(
            root.join("SKILL.md"),
            r#"---
name: folded-skill
description: >
  公文排版、标准格式、
  生成docx、红头文件
---

# Folded Skill
"#,
        )
        .expect("standard skill entry should be written");

        let manifest = load_manifest_from_dir(&root, "import")
            .expect("standard skill should parse")
            .expect("manifest should exist");
        assert_eq!(manifest.id, "folded-skill");
        assert!(manifest.description.contains("公文排版"));
        assert!(manifest.triggers.iter().any(|term| term == "红头文件"));

        fs::remove_dir_all(root).expect("test dir should be removed");
    }

    #[test]
    fn skill_execution_file_names_are_sanitized() {
        assert_eq!(
            sanitize_input_file_name("..\\evil.md").expect("md should be accepted"),
            "_evil.md"
        );
        assert!(sanitize_input_file_name("evil.exe").is_err());
        assert_eq!(
            sanitize_output_file_name("report.docx", "docx").expect("docx should be accepted"),
            "report.docx"
        );
        assert_eq!(
            sanitize_output_file_name("report.txt", "docx").expect("extension should be corrected"),
            "report.docx"
        );
    }

    #[test]
    fn skill_execution_allows_only_known_parameters() {
        assert_eq!(allowed_gongwen_parameter_flag("redhead"), Some("--redhead"));
        assert_eq!(
            allowed_gongwen_parameter_flag("docNumber"),
            Some("--doc-number")
        );
        assert_eq!(allowed_gongwen_parameter_flag("command"), None);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn extract_skill_zip_supports_windows_zip_package() {
        let source_root = create_test_dir("zip-source");
        let wrapped = source_root.join("wrapped-skill");
        write_standard_skill(&wrapped, "wrapped-skill");
        let zip_path = source_root.with_extension("zip");
        let output = std::process::Command::new("powershell")
            .env("NOVA_SKILL_SOURCE_PATH", &wrapped)
            .env("NOVA_SKILL_ZIP_PATH", &zip_path)
            .arg("-NoProfile")
            .arg("-NonInteractive")
            .arg("-ExecutionPolicy")
            .arg("Bypass")
            .arg("-Command")
            .arg("Compress-Archive -LiteralPath $env:NOVA_SKILL_SOURCE_PATH -DestinationPath $env:NOVA_SKILL_ZIP_PATH -Force")
            .output()
            .expect("PowerShell should start");
        assert!(
            output.status.success(),
            "Compress-Archive failed: {}",
            command_output_text(&output)
        );

        let extract_root = create_test_dir("zip-extract");
        extract_skill_zip(&zip_path, &extract_root).expect("zip package should be extracted");
        let found =
            find_extracted_skill_dir(&extract_root).expect("extracted skill should be found");
        assert_eq!(
            found.file_name().and_then(OsStr::to_str),
            Some("wrapped-skill")
        );

        fs::remove_dir_all(source_root).expect("source test dir should be removed");
        fs::remove_dir_all(extract_root).expect("extract test dir should be removed");
        fs::remove_file(zip_path).expect("zip test file should be removed");
    }
}
