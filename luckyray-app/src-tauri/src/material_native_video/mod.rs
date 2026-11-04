//! Local main-window media transport. No HTTP, permissions or arbitrary mpv commands.
use serde::{Deserialize, Serialize};

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    #[serde(default)]
    pub exclude: Vec<Exclusion>,
}
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Exclusion {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}
impl Bounds {
    fn validate(self) -> Result<Self, String> {
        // A scrolled card can extend outside the client viewport. Preserve its
        // full geometry; the parent window clips it instead of rescaling video.
        if self.x < -32768
            || self.y < -32768
            || self.width < 1
            || self.height < 1
            || [self.x, self.y, self.width, self.height]
                .iter()
                .any(|v| *v > 32768)
        {
            return Err("native-video-bounds-invalid".into());
        }
        if self.exclude.len() > 32
            || self.exclude.iter().any(|r| {
                r.x < 0
                    || r.y < 0
                    || r.width < 1
                    || r.height < 1
                    || i64::from(r.x) + i64::from(r.width) > i64::from(self.width)
                    || i64::from(r.y) + i64::from(r.height) > i64::from(self.height)
            })
        {
            return Err("native-video-region-invalid".into());
        }
        Ok(self)
    }
}
#[derive(Clone, Copy, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Range {
    pub start: f64,
    pub end: f64,
    pub looping: bool,
}
impl Range {
    fn validate(self, duration: f64) -> Result<Self, String> {
        if !self.start.is_finite()
            || !self.end.is_finite()
            || self.start < 0.
            || self.end <= self.start
            || self.end > duration + 0.001
        {
            return Err("native-video-range-invalid".into());
        }
        Ok(self)
    }
}
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Control {
    Play { range: Option<Range> },
    Pause,
    Seek { seconds: f64 },
    Volume { value: f64, muted: bool },
    Loop { enabled: bool },
    ClearRange,
}
#[derive(Deserialize)]
#[serde(
    tag = "op",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum Request {
    Capability,
    Open {
        session: String,
        library_id: String,
        asset_id: String,
        revision: String,
        bounds: Bounds,
        #[serde(default)]
        preview: bool,
    },
    Control {
        session: String,
        action: Control,
    },
    Snapshot {
        session: String,
    },
    Bounds {
        session: String,
        bounds: Bounds,
    },
    Capture {
        session: String,
    },
    PreviewFrame {
        session: String,
    },
    Close {
        session: String,
    },
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
mod mpv;
// V3 (T48): verified libmpv load + LGPL license gate on Linux. Playback and the
// surface below the WebView are not wired yet; see linux_mpv.rs.
#[cfg(target_os = "linux")]
mod linux_mpv;
// V1 (T45): metadata/thumbnail preview now runs on Linux with the verified
// media-engine FFmpeg tools. mpv/surface_region/windows_player stay Windows-only
// until V3. No Linux cfg change affects the Windows build or behaviour.
#[cfg(any(all(windows, feature = "browser-host-runtime"), target_os = "linux"))]
mod preview;
#[cfg(all(windows, feature = "browser-host-runtime"))]
mod surface_region;
#[cfg(all(windows, feature = "browser-host-runtime"))]
mod windows_player;

#[derive(Deserialize)]
#[serde(
    tag = "op",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum PreviewRequest {
    Metadata {
        job: String,
        library_id: String,
        asset_id: String,
    },
    Thumbnail {
        job: String,
        library_id: String,
        asset_id: String,
        revision: String,
        seconds: f64,
        #[serde(default)]
        cover: bool,
    },
    Cancel {
        job: String,
    },
}
#[tauri::command]
pub(crate) async fn material_video_preview_command(
    caller: tauri::Webview,
    app: tauri::AppHandle,
    request: PreviewRequest,
) -> Result<serde_json::Value, String> {
    crate::require_main_caller(&caller)?;
    #[cfg(all(windows, feature = "browser-host-runtime"))]
    return tauri::async_runtime::spawn_blocking(move || preview::request(caller, app, request))
        .await
        .map_err(|_| "native-video-preview-worker-failed".to_string())?;
    // Linux (T45 V1): keep the same capability refusal as Windows for a
    // missing/unverified runtime, then run the same preview::request pipeline.
    #[cfg(target_os = "linux")]
    {
        use tauri::Manager;
        let resources = app
            .path()
            .resource_dir()
            .map_err(|_| "native-video-resources-unavailable".to_string())?;
        // Hashing the runtime is blocking work, so it runs on the worker. The
        // pinned, stamp-checked verification is cached by preview::tool_dir;
        // a cancel never needs the tools.
        return tauri::async_runtime::spawn_blocking(move || {
            if !matches!(request, PreviewRequest::Cancel { .. }) {
                let verified = preview::tool_dir(&resources);
                if let Some(payload) = crate::linux_media_runtime::component_missing_error(&verified) {
                    return Err(payload);
                }
            }
            preview::request(caller, app, request)
        })
        .await
        .map_err(|_| "native-video-preview-worker-failed".to_string())?;
    }
    #[cfg(not(any(all(windows, feature = "browser-host-runtime"), target_os = "linux")))]
    {
        let _ = (&caller, &request, &app);
        Err("native-video-preview-unavailable".into())
    }
}

#[tauri::command]
pub(crate) async fn material_native_video_command(
    caller: tauri::Webview,
    app: tauri::AppHandle,
    request: Request,
) -> Result<serde_json::Value, String> {
    crate::require_main_caller(&caller)?;
    #[cfg(all(windows, feature = "browser-host-runtime"))]
    return tauri::async_runtime::spawn_blocking(move || {
        windows_player::request(caller, app, request)
    })
    .await
    .map_err(|_| "native-video-worker-failed".to_string())?;
    #[cfg(not(all(windows, feature = "browser-host-runtime")))]
    {
        let _ = (&caller, &request, &app);
        // Linux: capability stays honest (the player is not ported yet) while
        // the packaged runtime is verified exactly like Windows; a missing or
        // unverified runtime is its own capability refusal.
        #[cfg(target_os = "linux")]
        {
            use tauri::Manager;
            let resources = app
                .path()
                .resource_dir()
                .map_err(|_| "native-video-resources-unavailable".to_string())?;
            let verified = crate::media_transfer::verified_local_video_tools(&resources);
            if matches!(request, Request::Capability) {
                let mut payload = crate::linux_media_runtime::capability_payload(&verified);
                payload["playerRuntime"] = match linux_mpv::verify_bundled(&resources) {
                    Ok(()) => "verified".into(),
                    Err(code) => code.into(),
                };
                return Ok(payload);
            }
            if let Some(payload) = crate::linux_media_runtime::component_missing_error(&verified) {
                return Err(payload);
            }
        }
        if matches!(request, Request::Capability) {
            Ok(serde_json::json!({"available":false}))
        } else {
            Err("native-video-platform-unavailable".into())
        }
    }
}

pub(crate) fn shutdown() {
    #[cfg(all(windows, feature = "browser-host-runtime"))]
    windows_player::shutdown();
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_media_rejects_unbounded_geometry_and_ranges() {
        let viewport = Bounds {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
            exclude: vec![],
        };
        for hole in [
            Exclusion {
                x: -1,
                y: 0,
                width: 1,
                height: 1,
            },
            Exclusion {
                x: 0,
                y: 0,
                width: 0,
                height: 1,
            },
            Exclusion {
                x: 1919,
                y: 0,
                width: 2,
                height: 1,
            },
            Exclusion {
                x: 0,
                y: 1079,
                width: 1,
                height: 2,
            },
            Exclusion {
                x: i32::MAX,
                y: 0,
                width: i32::MAX,
                height: 1,
            },
        ] {
            assert!(Bounds {
                exclude: vec![hole],
                ..viewport.clone()
            }
            .validate()
            .is_err());
        }
        let full = Exclusion {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        };
        assert!(Bounds {
            exclude: vec![full],
            ..viewport.clone()
        }
        .validate()
        .is_ok());
        assert!(Bounds {
            exclude: vec![full; 33],
            ..viewport.clone()
        }
        .validate()
        .is_err());
        assert!(Bounds {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
            exclude: vec![],
        }
        .validate()
        .is_ok());
        assert!(Bounds {
            x: -1,
            y: 0,
            width: 1,
            height: 1,
            exclude: vec![],
        }
        .validate()
        .is_ok());
        assert!(Bounds { x: -32769, y: 0, width: 1, height: 1, exclude: vec![] }.validate().is_err());
        assert!(Bounds {
            x: 0,
            y: 0,
            width: 0,
            height: 1,
            exclude: vec![],
        }
        .validate()
        .is_err());
        for (start, end) in [(1., 1.), (2., 1.), (-1., 2.), (0., 11.), (f64::NAN, 2.)] {
            assert!(Range {
                start,
                end,
                looping: false
            }
            .validate(10.)
            .is_err());
        }
        assert!(Range {
            start: 1.,
            end: 2.,
            looping: true
        }
        .validate(10.)
        .is_ok());
        assert!(serde_json::from_value::<Request>(
            serde_json::json!({"op":"command","args":["loadfile","https://example.com"]})
        )
        .is_err());
        assert!(serde_json::from_value::<Control>(
            serde_json::json!({"op":"seek","seconds":2,"path":"secret"})
        )
        .is_err());
    }
}
