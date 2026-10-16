use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::backend::BackendServices;

const MIN_INTERVAL_SECONDS: u64 = 60;
const MAX_INTERVAL_SECONDS: u64 = 365 * 24 * 60 * 60;
const MAX_PROMPT_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ScheduleKind {
    Once,
    Interval,
}

impl ScheduleKind {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Once => "once",
            Self::Interval => "interval",
        }
    }
}

/// Validates the model-facing schedule timing shape without creating product
/// state. Relative one-time schedules remain relative until the approved
/// ToolRegistry execution, so time spent waiting for approval cannot make a
/// valid "in one minute" request stale.
pub(crate) fn validate_agent_schedule_timing(
    kind: &ScheduleKind,
    run_at: Option<&str>,
    interval_seconds: Option<u64>,
    delay_seconds: Option<u64>,
) -> Result<(), ScheduleError> {
    match kind {
        ScheduleKind::Once => {
            if interval_seconds.is_some() || run_at.is_some() == delay_seconds.is_some() {
                return Err(ScheduleError::new(
                    "schedule-input-invalid",
                    "A one-time schedule needs exactly one future time or relative delay",
                ));
            }
            if let Some(value) = run_at {
                parse_future_time(value)?;
            }
            if delay_seconds.is_some_and(|seconds| {
                !(MIN_INTERVAL_SECONDS..=MAX_INTERVAL_SECONDS).contains(&seconds)
            }) {
                return Err(ScheduleError::new(
                    "schedule-input-invalid",
                    "The relative schedule delay is outside the supported range",
                ));
            }
        }
        ScheduleKind::Interval => {
            if run_at.is_some()
                || delay_seconds.is_some()
                || !interval_seconds.is_some_and(|seconds| {
                    (MIN_INTERVAL_SECONDS..=MAX_INTERVAL_SECONDS).contains(&seconds)
                })
            {
                return Err(ScheduleError::new(
                    "schedule-input-invalid",
                    "The repeating schedule interval is outside the supported range",
                ));
            }
        }
    }
    Ok(())
}

/// Resolves relative timing only at the approved execution boundary. The
/// returned values are accepted by the existing ScheduleService validation,
/// which remains the single persistence authority.
pub(crate) fn resolve_agent_schedule_timing(
    kind: &ScheduleKind,
    run_at: Option<&str>,
    interval_seconds: Option<u64>,
    delay_seconds: Option<u64>,
) -> Result<(Option<String>, Option<u64>), ScheduleError> {
    validate_agent_schedule_timing(kind, run_at, interval_seconds, delay_seconds)?;
    match kind {
        ScheduleKind::Once => {
            let canonical = match (run_at, delay_seconds) {
                (Some(value), None) => parse_future_time(value)?.to_rfc3339(),
                (None, Some(seconds)) => {
                    (chrono::Utc::now() + chrono::Duration::seconds(seconds as i64)).to_rfc3339()
                }
                _ => unreachable!("timing shape was validated"),
            };
            Ok((Some(canonical), None))
        }
        ScheduleKind::Interval => Ok((None, interval_seconds)),
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ScheduleCreateInput {
    pub(crate) title: String,
    pub(crate) prompt: String,
    pub(crate) conversation_id: String,
    pub(crate) kind: ScheduleKind,
    #[serde(default)]
    pub(crate) run_at: Option<String>,
    #[serde(default)]
    pub(crate) interval_seconds: Option<u64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ScheduleQuickCreateInput {
    pub(crate) title: String,
    pub(crate) prompt: String,
    pub(crate) kind: ScheduleKind,
    #[serde(default)]
    pub(crate) run_at: Option<String>,
    #[serde(default)]
    pub(crate) interval_seconds: Option<u64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ScheduleEditInput {
    pub(crate) id: String,
    pub(crate) expected_revision: u64,
    pub(crate) title: String,
    pub(crate) prompt: String,
    pub(crate) kind: ScheduleKind,
    #[serde(default)]
    pub(crate) run_at: Option<String>,
    #[serde(default)]
    pub(crate) interval_seconds: Option<u64>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentSchedule {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) prompt: String,
    pub(crate) prompt_preview: String,
    #[serde(skip_serializing)]
    pub(crate) conversation_id: String,
    pub(crate) kind: ScheduleKind,
    pub(crate) interval_seconds: Option<u64>,
    pub(crate) next_fire_at: Option<String>,
    pub(crate) status: String,
    pub(crate) revision: u64,
    #[serde(skip_serializing)]
    pub(crate) last_run_id: Option<String>,
    #[serde(skip_serializing)]
    pub(crate) last_safe_code: Option<String>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) fires: Vec<AgentScheduleFire>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentScheduleFire {
    pub(crate) trigger_kind: String,
    pub(crate) status: String,
    pub(crate) run_id: Option<String>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScheduleTriggerResult {
    pub(crate) status: String,
    pub(crate) already_queued: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ScheduleError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl ScheduleError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ScheduleError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ScheduleError {}

#[derive(Clone, Debug)]
pub(crate) struct AgentScheduleService {
    db_path: PathBuf,
}

impl AgentScheduleService {
    pub(crate) fn initialize(db_path: impl Into<PathBuf>) -> Result<Self, ScheduleError> {
        let service = Self {
            db_path: db_path.into(),
        };
        service.reconcile_startup()?;
        Ok(service)
    }

    pub(crate) fn list(&self) -> Result<Vec<AgentSchedule>, ScheduleError> {
        let connection = self.open_read()?;
        let mut statement = connection
            .prepare(
                "SELECT id, title, prompt, conversation_id, kind, interval_seconds,
                        next_fire_at,
                        CASE WHEN retired_at IS NOT NULL THEN 'retired'
                             WHEN completed_at IS NOT NULL THEN 'completed'
                             ELSE status END,
                        revision, last_run_id, last_safe_code,
                        created_at, updated_at
                 FROM agent_schedule ORDER BY created_at DESC, id",
            )
            .map_err(|_| schedule_database_error())?;
        let rows = statement
            .query_map([], map_schedule_row)
            .map_err(|_| schedule_database_error())?;
        let mut schedules = Vec::new();
        for row in rows {
            let mut schedule = row.map_err(|_| schedule_database_error())?;
            schedule.fires = self.history(&schedule.id, 12)?;
            schedules.push(schedule);
        }
        Ok(schedules)
    }

    pub(crate) fn create(
        &self,
        mut input: ScheduleCreateInput,
    ) -> Result<AgentSchedule, ScheduleError> {
        validate_create(&mut input)?;
        let id = format!("schedule-{}", random_id());
        let now = chrono::Utc::now().to_rfc3339();
        let next_fire_at = initial_next_fire(&input)?;
        let connection = self.open_write()?;
        connection
            .execute(
                "INSERT INTO agent_schedule(
                    id, title, prompt, conversation_id, kind, interval_seconds,
                    next_fire_at, status, revision, last_run_id, last_safe_code,
                    created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active', 1, NULL, NULL, ?8, ?8)",
                params![
                    id,
                    input.title,
                    input.prompt,
                    input.conversation_id,
                    input.kind.as_str(),
                    input.interval_seconds,
                    next_fire_at,
                    now
                ],
            )
            .map_err(|_| schedule_database_error())?;
        self.get(&id)
    }

    /// Creates the schedule and its dedicated standard conversation in one
    /// SQLite admission transaction. The renderer never supplies a
    /// conversation id, so a project conversation cannot donate Workspace or
    /// Knowledge authority to a scheduled run. Any validation or persistence
    /// failure rolls both rows back.
    pub(crate) fn create_with_standard_conversation(
        &self,
        input: ScheduleQuickCreateInput,
    ) -> Result<AgentSchedule, ScheduleError> {
        let conversation_id = format!("conv-{}", random_id());
        let mut create = ScheduleCreateInput {
            title: input.title,
            prompt: input.prompt,
            conversation_id: conversation_id.clone(),
            kind: input.kind,
            run_at: input.run_at,
            interval_seconds: input.interval_seconds,
        };
        validate_create(&mut create)?;

        let schedule_id = format!("schedule-{}", random_id());
        let now = chrono::Utc::now().to_rfc3339();
        let next_fire_at = initial_next_fire(&create)?;
        let mut connection = self.open_write()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| schedule_database_error())?;
        transaction
            .execute(
                "INSERT INTO ai_conversation(
                     id,title,created_at,updated_at,agent_mode,project_id
                 ) VALUES (?1,?2,?3,?3,'standard',NULL)",
                params![conversation_id, create.title, now],
            )
            .map_err(|_| schedule_database_error())?;
        transaction
            .execute(
                "INSERT INTO agent_schedule(
                    id, title, prompt, conversation_id, kind, interval_seconds,
                    next_fire_at, status, revision, last_run_id, last_safe_code,
                    created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active', 1, NULL, NULL, ?8, ?8)",
                params![
                    schedule_id,
                    create.title,
                    create.prompt,
                    conversation_id,
                    create.kind.as_str(),
                    create.interval_seconds,
                    next_fire_at,
                    now
                ],
            )
            .map_err(|_| schedule_database_error())?;
        let schedule = transaction
            .query_row(
                "SELECT id, title, prompt, conversation_id, kind, interval_seconds,
                        next_fire_at, status, revision, last_run_id, last_safe_code,
                        created_at, updated_at
                 FROM agent_schedule WHERE id=?1",
                [&schedule_id],
                map_schedule_row,
            )
            .map_err(|_| schedule_database_error())?;
        transaction
            .commit()
            .map_err(|_| schedule_database_error())?;
        Ok(schedule)
    }

    pub(crate) fn edit(
        &self,
        mut input: ScheduleEditInput,
    ) -> Result<AgentSchedule, ScheduleError> {
        validate_public_id(&input.id)?;
        validate_edit(&mut input)?;
        let next_fire_at = edit_next_fire(&input)?;
        let mut connection = self.open_write()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| schedule_database_error())?;
        let changed = transaction
            .execute(
                "UPDATE agent_schedule
                 SET title = ?3, prompt = ?4, kind = ?5, interval_seconds = ?6,
                     next_fire_at = ?7, status = 'active', completed_at = NULL,
                     revision = revision + 1, updated_at = ?8
                 WHERE id = ?1 AND revision = ?2 AND retired_at IS NULL",
                params![
                    input.id,
                    input.expected_revision,
                    input.title,
                    input.prompt,
                    input.kind.as_str(),
                    input.interval_seconds,
                    next_fire_at,
                    chrono::Utc::now().to_rfc3339()
                ],
            )
            .map_err(|_| schedule_database_error())?;
        if changed != 1 {
            return Err(self.missing_or_conflict(&input.id)?);
        }
        transaction
            .execute(
                "UPDATE agent_schedule_fire
                 SET state = 'cancelled', safe_code = 'schedule-definition-changed', updated_at = ?2
                 WHERE schedule_id = ?1 AND state = 'prepared'",
                params![input.id, chrono::Utc::now().to_rfc3339()],
            )
            .map_err(|_| schedule_database_error())?;
        transaction
            .commit()
            .map_err(|_| schedule_database_error())?;
        self.get(&input.id)
    }

    pub(crate) fn pause(
        &self,
        id: &str,
        expected_revision: u64,
    ) -> Result<AgentSchedule, ScheduleError> {
        self.set_status(id, expected_revision, "paused")
    }

    pub(crate) fn resume(
        &self,
        id: &str,
        expected_revision: u64,
    ) -> Result<AgentSchedule, ScheduleError> {
        validate_public_id(id)?;
        let mut connection = self.open_write()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| schedule_database_error())?;
        let current = transaction
            .query_row(
                "SELECT kind, interval_seconds, next_fire_at
                 FROM agent_schedule
                 WHERE id = ?1 AND revision = ?2
                   AND retired_at IS NULL AND completed_at IS NULL",
                params![id, expected_revision],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<i64>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| schedule_database_error())?
            .ok_or_else(|| self.missing_or_conflict(id).unwrap_or_else(|error| error))?;
        let next_fire_at = if current.0 == "interval" {
            let interval = current.1.unwrap_or(MIN_INTERVAL_SECONDS as i64).max(60);
            Some((chrono::Utc::now() + chrono::Duration::seconds(interval)).to_rfc3339())
        } else {
            current.2
        };
        let changed = transaction
            .execute(
                "UPDATE agent_schedule
                 SET status = 'active', next_fire_at = ?3,
                     revision = revision + 1, updated_at = ?4
                 WHERE id = ?1 AND revision = ?2",
                params![
                    id,
                    expected_revision,
                    next_fire_at,
                    chrono::Utc::now().to_rfc3339()
                ],
            )
            .map_err(|_| schedule_database_error())?;
        if changed != 1 {
            return Err(schedule_conflict());
        }
        transaction
            .commit()
            .map_err(|_| schedule_database_error())?;
        self.get(id)
    }

    pub(crate) fn remove(&self, id: &str, expected_revision: u64) -> Result<(), ScheduleError> {
        validate_public_id(id)?;
        let mut connection = self.open_write()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| schedule_database_error())?;
        let now = chrono::Utc::now().to_rfc3339();
        let changed = transaction
            .execute(
                "UPDATE agent_schedule
                 SET status = 'paused', next_fire_at = NULL, retired_at = ?3,
                     revision = revision + 1, updated_at = ?3
                 WHERE id = ?1 AND revision = ?2 AND retired_at IS NULL",
                params![id, expected_revision, now],
            )
            .map_err(|_| schedule_database_error())?;
        if changed != 1 {
            return Err(self.missing_or_conflict(id)?);
        }
        transaction
            .execute(
                "UPDATE agent_schedule_fire
                 SET state = 'cancelled', safe_code = 'schedule-removed', updated_at = ?2
                 WHERE schedule_id = ?1
                   AND ((state = 'prepared') OR (state = 'starting' AND run_id IS NULL))",
                params![id, now],
            )
            .map_err(|_| schedule_database_error())?;
        transaction
            .commit()
            .map_err(|_| schedule_database_error())?;
        Ok(())
    }

    pub(crate) fn manual_trigger(
        &self,
        id: &str,
        expected_revision: u64,
    ) -> Result<ScheduleTriggerResult, ScheduleError> {
        validate_public_id(id)?;
        let mut connection = self.open_write()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| schedule_database_error())?;
        let exists = transaction
            .query_row(
                "SELECT 1 FROM agent_schedule
                 WHERE id = ?1 AND revision = ?2 AND status = 'active'
                   AND retired_at IS NULL AND completed_at IS NULL",
                params![id, expected_revision],
                |_| Ok(()),
            )
            .optional()
            .map_err(|_| schedule_database_error())?
            .is_some();
        if !exists {
            let current = self.get(id);
            return Err(match current {
                Ok(schedule) if schedule.status != "active" => ScheduleError::new(
                    "schedule-not-active",
                    "Schedule must be active before it can run",
                ),
                Ok(_) => schedule_conflict(),
                Err(error) => error,
            });
        }
        let existing_fire = transaction
            .query_row(
                "SELECT id FROM agent_schedule_fire
                 WHERE schedule_id = ?1
                   AND state IN ('prepared','starting','running','awaiting-approval')
                 ORDER BY created_at, id LIMIT 1",
                [id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| schedule_database_error())?;
        if existing_fire.is_some() {
            transaction
                .commit()
                .map_err(|_| schedule_database_error())?;
            return Ok(ScheduleTriggerResult {
                status: "queued".to_owned(),
                already_queued: true,
            });
        }
        let fire_id = format!("fire-{}", random_id());
        let now = chrono::Utc::now().to_rfc3339();
        transaction
            .execute(
                "INSERT INTO agent_schedule_fire(
                    id, schedule_id, due_at, trigger_kind, state, run_id,
                    safe_code, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, 'manual', 'prepared', NULL, NULL, ?3, ?3)",
                params![fire_id, id, now],
            )
            .map_err(|_| schedule_database_error())?;
        transaction
            .commit()
            .map_err(|_| schedule_database_error())?;
        Ok(ScheduleTriggerResult {
            status: "queued".to_owned(),
            already_queued: false,
        })
    }

    fn claim_next_fire(&self) -> Result<Option<ScheduleClaim>, ScheduleError> {
        let mut connection = self.open_write()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| schedule_database_error())?;
        let now = chrono::Utc::now();
        let mut prepared = transaction
            .query_row(
                "SELECT f.id, s.conversation_id, s.prompt
                 FROM agent_schedule_fire f
                 JOIN agent_schedule s ON s.id = f.schedule_id
                 WHERE f.state = 'prepared' AND s.status = 'active'
                   AND s.retired_at IS NULL AND s.completed_at IS NULL
                 ORDER BY f.created_at, f.id LIMIT 1",
                [],
                |row| {
                    Ok(ScheduleClaim {
                        fire_id: row.get(0)?,
                        conversation_id: row.get(1)?,
                        prompt: row.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(|_| schedule_database_error())?;
        if prepared.is_none() {
            let due = transaction
                .query_row(
                    "SELECT id, conversation_id, prompt, kind, interval_seconds, next_fire_at
                     FROM agent_schedule
                     WHERE status = 'active' AND retired_at IS NULL
                       AND completed_at IS NULL
                       AND next_fire_at IS NOT NULL AND next_fire_at <= ?1
                     ORDER BY next_fire_at, id LIMIT 1",
                    [now.to_rfc3339()],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, Option<i64>>(4)?,
                            row.get::<_, String>(5)?,
                        ))
                    },
                )
                .optional()
                .map_err(|_| schedule_database_error())?;
            if let Some(due) = due {
                let fire_id = format!("fire-{}", random_id());
                transaction
                    .execute(
                        "INSERT INTO agent_schedule_fire(
                            id, schedule_id, due_at, trigger_kind, state, run_id,
                            safe_code, created_at, updated_at
                         ) VALUES (?1, ?2, ?3, 'scheduled', 'prepared', NULL, NULL, ?4, ?4)",
                        params![fire_id, due.0, due.5, now.to_rfc3339()],
                    )
                    .map_err(|_| schedule_database_error())?;
                if due.3 == "interval" {
                    let interval = due.4.unwrap_or(MIN_INTERVAL_SECONDS as i64).max(60);
                    let next = now + chrono::Duration::seconds(interval);
                    transaction
                        .execute(
                            "UPDATE agent_schedule
                             SET next_fire_at = ?2, revision = revision + 1, updated_at = ?3
                             WHERE id = ?1",
                            params![due.0, next.to_rfc3339(), now.to_rfc3339()],
                        )
                        .map_err(|_| schedule_database_error())?;
                } else {
                    transaction
                        .execute(
                            "UPDATE agent_schedule
                             SET status = 'paused', next_fire_at = NULL, completed_at = ?2,
                                 revision = revision + 1, updated_at = ?2
                             WHERE id = ?1",
                            params![due.0, now.to_rfc3339()],
                        )
                        .map_err(|_| schedule_database_error())?;
                }
                prepared = Some(ScheduleClaim {
                    fire_id,
                    conversation_id: due.1,
                    prompt: due.2,
                });
            }
        }
        let Some(claim) = prepared else {
            transaction
                .commit()
                .map_err(|_| schedule_database_error())?;
            return Ok(None);
        };
        let changed = transaction
            .execute(
                "UPDATE agent_schedule_fire
                 SET state = 'starting', updated_at = ?2
                 WHERE id = ?1 AND state = 'prepared'",
                params![claim.fire_id, now.to_rfc3339()],
            )
            .map_err(|_| schedule_database_error())?;
        if changed != 1 {
            transaction
                .commit()
                .map_err(|_| schedule_database_error())?;
            return Ok(None);
        }
        transaction
            .commit()
            .map_err(|_| schedule_database_error())?;
        Ok(Some(claim))
    }

    fn release_busy_claim(&self, fire_id: &str) -> Result<(), ScheduleError> {
        let connection = self.open_write()?;
        connection
            .execute(
                "UPDATE agent_schedule_fire
                 SET state = 'prepared', updated_at = ?2
                 WHERE id = ?1 AND state = 'starting'",
                params![fire_id, chrono::Utc::now().to_rfc3339()],
            )
            .map_err(|_| schedule_database_error())?;
        Ok(())
    }

    fn mark_start_failed(
        &self,
        fire_id: &str,
        safe_code: &'static str,
    ) -> Result<(), ScheduleError> {
        let mut connection = self.open_write()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| schedule_database_error())?;
        let changed = transaction
            .execute(
                "UPDATE agent_schedule_fire
                 SET state = 'failed', safe_code = ?2, updated_at = ?3
                 WHERE id = ?1 AND state = 'starting'",
                params![fire_id, safe_code, chrono::Utc::now().to_rfc3339()],
            )
            .map_err(|_| schedule_database_error())?;
        if changed == 1 {
            transaction
                .execute(
                    "UPDATE agent_schedule
                     SET last_safe_code = ?2, updated_at = ?3
                     WHERE id = (SELECT schedule_id FROM agent_schedule_fire WHERE id = ?1)",
                    params![fire_id, safe_code, chrono::Utc::now().to_rfc3339()],
                )
                .map_err(|_| schedule_database_error())?;
        }
        transaction
            .commit()
            .map_err(|_| schedule_database_error())?;
        Ok(())
    }

    fn claim_retired_run_stop(&self) -> Result<Option<String>, ScheduleError> {
        let mut connection = self.open_write()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| schedule_database_error())?;
        let candidate = transaction
            .query_row(
                "SELECT f.id, f.run_id
                 FROM agent_schedule_fire f
                 JOIN agent_schedule s ON s.id = f.schedule_id
                 WHERE s.retired_at IS NOT NULL
                   AND f.run_id IS NOT NULL
                   AND f.state IN ('running','awaiting-approval')
                   AND f.stop_requested_at IS NULL
                 ORDER BY f.created_at, f.id LIMIT 1",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(|_| schedule_database_error())?;
        let Some((fire_id, run_id)) = candidate else {
            transaction
                .commit()
                .map_err(|_| schedule_database_error())?;
            return Ok(None);
        };
        let changed = transaction
            .execute(
                "UPDATE agent_schedule_fire SET stop_requested_at = ?2, updated_at = ?2
                 WHERE id = ?1 AND stop_requested_at IS NULL",
                params![fire_id, chrono::Utc::now().to_rfc3339()],
            )
            .map_err(|_| schedule_database_error())?;
        transaction
            .commit()
            .map_err(|_| schedule_database_error())?;
        Ok((changed == 1).then_some(run_id))
    }

    pub(crate) fn refresh_running_fires(
        &self,
        backend: &BackendServices,
    ) -> Result<(), ScheduleError> {
        let active = {
            let connection = self.open_read()?;
            let mut statement = connection
                .prepare(
                    "SELECT run_id, schedule_id FROM agent_schedule_fire
                     WHERE run_id IS NOT NULL
                       AND state IN ('running','awaiting-approval')
                     ORDER BY created_at, id",
                )
                .map_err(|_| schedule_database_error())?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|_| schedule_database_error())?;
            let mut active = Vec::new();
            for row in rows {
                active.push(row.map_err(|_| schedule_database_error())?);
            }
            active
        };
        let connection = self.open_write()?;
        for (run_id, schedule_id) in active {
            let run = backend
                .agent_runs()
                .get(&run_id)
                .map_err(|_| schedule_database_error())?;
            if !matches!(
                run.status.as_str(),
                "completed" | "partial" | "failed" | "cancelled" | "aborted" | "interrupted"
            ) {
                if matches!(run.status.as_str(), "running" | "awaiting-approval") {
                    connection
                        .execute(
                            "UPDATE agent_schedule_fire
                             SET state = ?2, updated_at = ?3
                             WHERE run_id = ?1
                               AND state IN ('running','awaiting-approval')",
                            params![run.id, run.status, chrono::Utc::now().to_rfc3339()],
                        )
                        .map_err(|_| schedule_database_error())?;
                }
                continue;
            }
            connection
                .execute(
                    "UPDATE agent_schedule_fire
                     SET state = ?2, safe_code = ?3, updated_at = ?4
                     WHERE run_id = ?1
                       AND state IN ('running','awaiting-approval')",
                    params![
                        run.id,
                        run.status,
                        run.safe_code,
                        chrono::Utc::now().to_rfc3339()
                    ],
                )
                .map_err(|_| schedule_database_error())?;
            connection
                .execute(
                    "UPDATE agent_schedule
                     SET last_safe_code = ?2, updated_at = ?3
                     WHERE id = ?1 AND last_run_id = ?4",
                    params![
                        schedule_id,
                        run.safe_code,
                        chrono::Utc::now().to_rfc3339(),
                        run.id
                    ],
                )
                .map_err(|_| schedule_database_error())?;
        }
        Ok(())
    }

    fn reconcile_startup(&self) -> Result<(), ScheduleError> {
        let connection = self.open_write()?;
        connection
            .execute(
                "UPDATE agent_schedule_fire
                 SET state = 'interrupted', safe_code = 'agent-run-interrupted',
                     updated_at = ?1
                 WHERE state IN ('starting','running','awaiting-approval')",
                [chrono::Utc::now().to_rfc3339()],
            )
            .map_err(|_| schedule_database_error())?;
        Ok(())
    }

    fn set_status(
        &self,
        id: &str,
        expected_revision: u64,
        status: &str,
    ) -> Result<AgentSchedule, ScheduleError> {
        validate_public_id(id)?;
        let mut connection = self.open_write()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| schedule_database_error())?;
        let now = chrono::Utc::now().to_rfc3339();
        let changed = transaction
            .execute(
                "UPDATE agent_schedule
                 SET status = ?3, revision = revision + 1, updated_at = ?4
                 WHERE id = ?1 AND revision = ?2
                   AND retired_at IS NULL AND completed_at IS NULL",
                params![id, expected_revision, status, now],
            )
            .map_err(|_| schedule_database_error())?;
        if changed != 1 {
            return Err(self.missing_or_conflict(id)?);
        }
        if status == "paused" {
            transaction
                .execute(
                    "UPDATE agent_schedule_fire
                     SET state = 'cancelled', safe_code = 'schedule-paused', updated_at = ?2
                     WHERE schedule_id = ?1 AND state = 'prepared'",
                    params![id, now],
                )
                .map_err(|_| schedule_database_error())?;
        }
        transaction
            .commit()
            .map_err(|_| schedule_database_error())?;
        self.get(id)
    }

    fn get(&self, id: &str) -> Result<AgentSchedule, ScheduleError> {
        let connection = self.open_read()?;
        connection
            .query_row(
                "SELECT id, title, prompt, conversation_id, kind, interval_seconds,
                        next_fire_at,
                        CASE WHEN retired_at IS NOT NULL THEN 'retired'
                             WHEN completed_at IS NOT NULL THEN 'completed'
                             ELSE status END,
                        revision, last_run_id, last_safe_code,
                        created_at, updated_at
                 FROM agent_schedule WHERE id = ?1",
                [id],
                map_schedule_row,
            )
            .optional()
            .map_err(|_| schedule_database_error())?
            .ok_or_else(|| ScheduleError::new("schedule-not-found", "Schedule no longer exists"))
            .and_then(|mut schedule| {
                schedule.fires = self.history(id, 12)?;
                Ok(schedule)
            })
    }

    fn history(&self, id: &str, limit: usize) -> Result<Vec<AgentScheduleFire>, ScheduleError> {
        let connection = self.open_read()?;
        let mut statement = connection
            .prepare(
                "SELECT trigger_kind, state, run_id, created_at, updated_at
                 FROM agent_schedule_fire WHERE schedule_id = ?1
                 ORDER BY created_at DESC, id DESC LIMIT ?2",
            )
            .map_err(|_| schedule_database_error())?;
        let rows = statement
            .query_map(params![id, limit.clamp(1, 50) as i64], |row| {
                Ok(AgentScheduleFire {
                    trigger_kind: row.get(0)?,
                    status: product_fire_status(&row.get::<_, String>(1)?).to_owned(),
                    run_id: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            })
            .map_err(|_| schedule_database_error())?;
        let mut history = Vec::new();
        for row in rows {
            history.push(row.map_err(|_| schedule_database_error())?);
        }
        Ok(history)
    }

    fn missing_or_conflict(&self, id: &str) -> Result<ScheduleError, ScheduleError> {
        let connection = self.open_read()?;
        let current = connection
            .query_row("SELECT 1 FROM agent_schedule WHERE id = ?1", [id], |_| {
                Ok(())
            })
            .optional()
            .map_err(|_| schedule_database_error())?
            .is_some();
        Ok(if current {
            schedule_conflict()
        } else {
            ScheduleError::new("schedule-not-found", "Schedule no longer exists")
        })
    }

    fn open_read(&self) -> Result<Connection, ScheduleError> {
        open_connection(
            &self.db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
    }

    fn open_write(&self) -> Result<Connection, ScheduleError> {
        open_connection(
            &self.db_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
    }
}

struct ScheduleClaim {
    fire_id: String,
    conversation_id: String,
    prompt: String,
}

fn map_schedule_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentSchedule> {
    let prompt = row.get::<_, String>(2)?;
    let kind = match row.get::<_, String>(4)?.as_str() {
        "once" => ScheduleKind::Once,
        _ => ScheduleKind::Interval,
    };
    Ok(AgentSchedule {
        id: row.get(0)?,
        title: row.get(1)?,
        prompt_preview: prompt.chars().take(160).collect(),
        prompt,
        conversation_id: row.get(3)?,
        kind,
        interval_seconds: row
            .get::<_, Option<i64>>(5)?
            .map(|value| value.max(0) as u64),
        next_fire_at: row.get(6)?,
        status: row.get(7)?,
        revision: row.get::<_, i64>(8)?.max(0) as u64,
        last_run_id: row.get(9)?,
        last_safe_code: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
        fires: Vec::new(),
    })
}

fn product_fire_status(state: &str) -> &'static str {
    match state {
        "prepared" | "starting" => "queued",
        "running" => "running",
        "awaiting-approval" => "awaiting-approval",
        "completed" => "completed",
        "partial" => "partial",
        "cancelled" | "aborted" => "cancelled",
        "interrupted" => "interrupted",
        _ => "failed",
    }
}

fn validate_create(input: &mut ScheduleCreateInput) -> Result<(), ScheduleError> {
    input.title = input.title.trim().to_owned();
    input.prompt = input.prompt.trim().to_owned();
    validate_common(
        &input.title,
        &input.prompt,
        &input.conversation_id,
        &input.kind,
        input.run_at.as_deref(),
        input.interval_seconds,
    )
}

fn validate_edit(input: &mut ScheduleEditInput) -> Result<(), ScheduleError> {
    input.title = input.title.trim().to_owned();
    input.prompt = input.prompt.trim().to_owned();
    validate_common(
        &input.title,
        &input.prompt,
        "existing-conversation",
        &input.kind,
        input.run_at.as_deref(),
        input.interval_seconds,
    )
}

fn validate_common(
    title: &str,
    prompt: &str,
    conversation_id: &str,
    kind: &ScheduleKind,
    run_at: Option<&str>,
    interval_seconds: Option<u64>,
) -> Result<(), ScheduleError> {
    validate_public_id(conversation_id)?;
    if title.is_empty()
        || title.chars().count() > 120
        || prompt.is_empty()
        || prompt.as_bytes().len() > MAX_PROMPT_BYTES
        || prompt.contains('\0')
    {
        return Err(ScheduleError::new(
            "schedule-input-invalid",
            "Schedule title or prompt is invalid",
        ));
    }
    match kind {
        ScheduleKind::Once => {
            if interval_seconds.is_some() {
                return Err(ScheduleError::new(
                    "schedule-input-invalid",
                    "One-time schedules cannot have an interval",
                ));
            }
            parse_future_time(run_at.ok_or_else(|| {
                ScheduleError::new("schedule-input-invalid", "One-time run time is required")
            })?)?;
        }
        ScheduleKind::Interval => {
            if run_at.is_some()
                || !interval_seconds.is_some_and(|seconds| {
                    (MIN_INTERVAL_SECONDS..=MAX_INTERVAL_SECONDS).contains(&seconds)
                })
            {
                return Err(ScheduleError::new(
                    "schedule-input-invalid",
                    "Schedule interval is outside the supported range",
                ));
            }
        }
    }
    Ok(())
}

fn initial_next_fire(input: &ScheduleCreateInput) -> Result<String, ScheduleError> {
    match input.kind {
        ScheduleKind::Once => {
            Ok(parse_future_time(input.run_at.as_deref().ok_or_else(|| {
                ScheduleError::new("schedule-input-invalid", "Run time required")
            })?)?
            .to_rfc3339())
        }
        ScheduleKind::Interval => Ok((chrono::Utc::now()
            + chrono::Duration::seconds(
                input.interval_seconds.unwrap_or(MIN_INTERVAL_SECONDS) as i64
            ))
        .to_rfc3339()),
    }
}

fn edit_next_fire(input: &ScheduleEditInput) -> Result<String, ScheduleError> {
    match input.kind {
        ScheduleKind::Once => {
            Ok(parse_future_time(input.run_at.as_deref().ok_or_else(|| {
                ScheduleError::new("schedule-input-invalid", "Run time required")
            })?)?
            .to_rfc3339())
        }
        ScheduleKind::Interval => Ok((chrono::Utc::now()
            + chrono::Duration::seconds(
                input.interval_seconds.unwrap_or(MIN_INTERVAL_SECONDS) as i64
            ))
        .to_rfc3339()),
    }
}

fn parse_future_time(value: &str) -> Result<chrono::DateTime<chrono::Utc>, ScheduleError> {
    let parsed = chrono::DateTime::parse_from_rfc3339(value)
        .map_err(|_| ScheduleError::new("schedule-input-invalid", "Schedule time is invalid"))?
        .with_timezone(&chrono::Utc);
    if parsed <= chrono::Utc::now() {
        return Err(ScheduleError::new(
            "schedule-input-invalid",
            "Schedule time must be in the future",
        ));
    }
    Ok(parsed)
}

fn validate_public_id(value: &str) -> Result<(), ScheduleError> {
    if value.is_empty()
        || value.len() > 160
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.'))
    {
        return Err(ScheduleError::new(
            "schedule-identity-invalid",
            "Schedule identity is invalid",
        ));
    }
    Ok(())
}

fn open_connection(path: &Path, flags: OpenFlags) -> Result<Connection, ScheduleError> {
    let connection =
        Connection::open_with_flags(path, flags).map_err(|_| schedule_database_error())?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|_| schedule_database_error())?;
    Ok(connection)
}

fn schedule_conflict() -> ScheduleError {
    ScheduleError::new(
        "schedule-revision-conflict",
        "Schedule changed; reload before applying this proposal",
    )
}

fn schedule_database_error() -> ScheduleError {
    ScheduleError::new(
        "schedule-store-unavailable",
        "Schedule state is unavailable",
    )
}

fn random_id() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded_service() -> (tempfile::TempDir, AgentScheduleService) {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("schedules.db");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE ai_conversation (
                    id TEXT PRIMARY KEY, title TEXT NOT NULL,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    agent_mode TEXT NOT NULL DEFAULT 'standard', project_id TEXT
                 );
                 CREATE TABLE agent_schedule (
                    id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL,
                    conversation_id TEXT NOT NULL, kind TEXT NOT NULL,
                    interval_seconds INTEGER, next_fire_at TEXT, status TEXT NOT NULL,
                    revision INTEGER NOT NULL, last_run_id TEXT, last_safe_code TEXT,
                    retired_at TEXT, completed_at TEXT,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                 );
                 CREATE TABLE agent_schedule_fire (
                    id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, due_at TEXT NOT NULL,
                    trigger_kind TEXT NOT NULL, state TEXT NOT NULL, run_id TEXT,
                    safe_code TEXT, stop_requested_at TEXT,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                 );",
            )
            .unwrap();
        (temp, AgentScheduleService::initialize(path).unwrap())
    }

    fn interval_input() -> ScheduleCreateInput {
        ScheduleCreateInput {
            title: "Daily synthesis".into(),
            prompt: "Summarize the current evidence".into(),
            conversation_id: "conv-1".into(),
            kind: ScheduleKind::Interval,
            run_at: None,
            interval_seconds: Some(3600),
        }
    }

    fn quick_interval_input() -> ScheduleQuickCreateInput {
        ScheduleQuickCreateInput {
            title: "Daily synthesis".into(),
            prompt: "Summarize the current evidence".into(),
            kind: ScheduleKind::Interval,
            run_at: None,
            interval_seconds: Some(3600),
        }
    }

    #[test]
    fn quick_create_is_one_atomic_standard_unbound_conversation_and_schedule() {
        let (_temp, service) = seeded_service();
        let schedule = service
            .create_with_standard_conversation(quick_interval_input())
            .unwrap();
        let connection = service.open_read().unwrap();
        let conversation = connection
            .query_row(
                "SELECT agent_mode, project_id FROM ai_conversation WHERE id=?1",
                [&schedule.conversation_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .unwrap();
        assert_eq!(conversation, ("standard".to_owned(), None));
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM ai_conversation", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM agent_schedule", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn quick_create_rolls_back_the_conversation_when_schedule_insert_fails() {
        let (_temp, service) = seeded_service();
        service
            .open_write()
            .unwrap()
            .execute_batch(
                "CREATE TRIGGER reject_quick_schedule
                 BEFORE INSERT ON agent_schedule
                 BEGIN SELECT RAISE(ABORT, 'fixture-reject'); END;",
            )
            .unwrap();

        assert_eq!(
            service
                .create_with_standard_conversation(quick_interval_input())
                .unwrap_err()
                .code,
            "schedule-store-unavailable"
        );
        let connection = service.open_read().unwrap();
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM ai_conversation", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM agent_schedule", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn interval_bounds_are_enforced() {
        let mut too_fast = ScheduleCreateInput {
            title: "fast".into(),
            prompt: "do work".into(),
            conversation_id: "conv-1".into(),
            kind: ScheduleKind::Interval,
            run_at: None,
            interval_seconds: Some(1),
        };
        assert_eq!(
            validate_create(&mut too_fast).unwrap_err().code,
            "schedule-input-invalid"
        );
    }

    #[test]
    fn prompt_preview_is_bounded() {
        let prompt = "a".repeat(1_000);
        let preview = prompt.chars().take(160).collect::<String>();
        assert_eq!(preview.len(), 160);
    }

    #[test]
    fn public_schedule_projection_omits_backend_conversation_and_failure_fields() {
        let (_temp, service) = seeded_service();
        let schedule = service.create(interval_input()).unwrap();
        service
            .open_write()
            .unwrap()
            .execute(
                "UPDATE agent_schedule SET last_run_id='run-private', last_safe_code='private-code'
                 WHERE id=?1",
                [&schedule.id],
            )
            .unwrap();
        let projected = serde_json::to_value(service.get(&schedule.id).unwrap()).unwrap();
        assert!(projected.get("conversationId").is_none());
        assert!(projected.get("lastRunId").is_none());
        assert!(projected.get("lastSafeCode").is_none());
        assert!(!projected.to_string().contains("private-code"));
    }

    #[test]
    fn concurrent_manual_trigger_has_one_active_fire() {
        let (_temp, service) = seeded_service();
        let schedule = service.create(interval_input()).unwrap();
        let first = service
            .manual_trigger(&schedule.id, schedule.revision)
            .unwrap();
        let second = service
            .manual_trigger(&schedule.id, schedule.revision)
            .unwrap();
        assert!(!first.already_queued);
        assert!(second.already_queued);
        let connection = service.open_read().unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM agent_schedule_fire WHERE schedule_id = ?1",
                    [&schedule.id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn startup_interrupts_inflight_fire_without_requeue() {
        let (temp, service) = seeded_service();
        let schedule = service.create(interval_input()).unwrap();
        service
            .manual_trigger(&schedule.id, schedule.revision)
            .unwrap();
        let fire = service
            .open_read()
            .unwrap()
            .query_row(
                "SELECT id FROM agent_schedule_fire WHERE schedule_id = ?1",
                [&schedule.id],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        service
            .open_write()
            .unwrap()
            .execute(
                "UPDATE agent_schedule_fire SET state = 'running', run_id = 'run-old'
                 WHERE id = ?1",
                [&fire],
            )
            .unwrap();
        let restarted = AgentScheduleService::initialize(temp.path().join("schedules.db")).unwrap();
        let connection = restarted.open_read().unwrap();
        let state = connection
            .query_row(
                "SELECT state FROM agent_schedule_fire WHERE id = ?1",
                [&fire],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        assert_eq!(state, "interrupted");
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM agent_schedule_fire WHERE state = 'prepared'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
        drop(connection);
        let current = restarted.get(&schedule.id).unwrap();
        restarted
            .manual_trigger(&current.id, current.revision)
            .unwrap();
        let fresh_fire = restarted
            .open_read()
            .unwrap()
            .query_row(
                "SELECT id FROM agent_schedule_fire WHERE schedule_id = ?1 AND state = 'prepared'",
                [&schedule.id],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        assert_ne!(fresh_fire, fire, "restart must create a new fire identity");
        assert_eq!(
            restarted
                .open_read()
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM agent_schedule_fire WHERE schedule_id = ?1",
                    [&schedule.id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            2,
            "the interrupted fire remains history and is never replayed"
        );
    }

    #[test]
    fn paused_schedule_rejects_manual_trigger_and_cancels_prepared_fire() {
        let (_temp, service) = seeded_service();
        let schedule = service.create(interval_input()).unwrap();
        service
            .manual_trigger(&schedule.id, schedule.revision)
            .unwrap();
        let paused = service.pause(&schedule.id, schedule.revision).unwrap();
        assert_eq!(paused.status, "paused");
        let error = service
            .manual_trigger(&paused.id, paused.revision)
            .unwrap_err();
        assert_eq!(error.code, "schedule-not-active");
        let connection = service.open_read().unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM agent_schedule_fire
                     WHERE schedule_id = ?1 AND state = 'prepared'",
                    [&schedule.id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0,
            "pause must cancel work that has not started"
        );
    }

    #[test]
    fn remove_is_soft_and_preserves_fire_history() {
        let (_temp, service) = seeded_service();
        let schedule = service.create(interval_input()).unwrap();
        service
            .manual_trigger(&schedule.id, schedule.revision)
            .unwrap();
        service.remove(&schedule.id, schedule.revision).unwrap();
        let connection = service.open_read().unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM agent_schedule WHERE id = ?1",
                    [&schedule.id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1,
            "remove must retain the definition for history and ledger attribution"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM agent_schedule_fire WHERE schedule_id = ?1",
                    [&schedule.id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1,
            "remove must not erase trigger history"
        );
    }

    #[test]
    fn retired_schedule_requests_active_run_stop_exactly_once_and_keeps_history() {
        let (_temp, service) = seeded_service();
        let schedule = service.create(interval_input()).unwrap();
        service
            .manual_trigger(&schedule.id, schedule.revision)
            .unwrap();
        service
            .open_write()
            .unwrap()
            .execute(
                "UPDATE agent_schedule_fire
                 SET state='running',run_id='run-scheduled-active'
                 WHERE schedule_id=?1",
                [&schedule.id],
            )
            .unwrap();
        service.remove(&schedule.id, schedule.revision).unwrap();
        assert_eq!(
            service.claim_retired_run_stop().unwrap().as_deref(),
            Some("run-scheduled-active")
        );
        assert_eq!(service.claim_retired_run_stop().unwrap(), None);
        let retired = service.get(&schedule.id).unwrap();
        assert_eq!(retired.status, "retired");
        assert_eq!(retired.fires.len(), 1);
        assert_eq!(retired.fires[0].status, "running");
    }

    #[test]
    fn edit_cancels_old_prepared_fire_and_reschedules_from_new_revision() {
        let (_temp, service) = seeded_service();
        let schedule = service.create(interval_input()).unwrap();
        service
            .manual_trigger(&schedule.id, schedule.revision)
            .unwrap();
        let edited = service
            .edit(ScheduleEditInput {
                id: schedule.id.clone(),
                expected_revision: schedule.revision,
                title: "Weekly synthesis".to_owned(),
                prompt: "Summarize the current week".to_owned(),
                kind: ScheduleKind::Interval,
                run_at: None,
                interval_seconds: Some(7 * 24 * 60 * 60),
            })
            .unwrap();
        assert_eq!(edited.revision, schedule.revision + 1);
        assert_eq!(edited.title, "Weekly synthesis");
        assert_eq!(edited.fires.len(), 1);
        assert_eq!(edited.fires[0].status, "cancelled");
    }

    #[test]
    fn manual_trigger_returns_only_product_queue_state() {
        let (_temp, service) = seeded_service();
        let schedule = service.create(interval_input()).unwrap();
        let queued = service
            .manual_trigger(&schedule.id, schedule.revision)
            .unwrap();
        let serialized = serde_json::to_string(&queued).unwrap();
        assert_eq!(queued.status, "queued");
        assert!(!serialized.contains("fire-"));
        assert!(!serialized.contains(&schedule.id));
    }
}
