//! Disk-backed fixed dataset membership.

#[cfg(test)]
use std::sync::atomic::{AtomicUsize, Ordering};
use std::{
    fmt, fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use duckdb::{
    Config, Connection, Error as DuckDbError, appender_params_from_iter, params_from_iter,
    types::Value,
};
use tempfile::TempDir;

use super::{
    DataWindowError, DatasetError, DatasetMember, DatasetPartitionNode, DatasetPartitionPage,
    HIVE_DEFAULT_PARTITION, MAX_DATASET_SCHEMA_BYTES, MAX_DATASET_SCHEMA_NODES, MemberIdentity,
    PartitionColumn, PartitionColumnKind, PartitionValue, PlatformFileIdentity,
    canonical_partition_i64,
};

const CATALOG_MEMORY_LIMIT: &str = "64MB";
pub(super) const CATALOG_PAGE_MEMBERS: u32 = 256;
const CATALOG_PAGE_BYTES: usize = 1024 * 1024;

pub(super) struct MemberCatalog {
    connection: Mutex<Connection>,
    _directory: TempDir,
    member_count: u64,
    #[cfg(test)]
    member_batch_queries: AtomicUsize,
    #[cfg(test)]
    target_lookup_queries: AtomicUsize,
}

impl fmt::Debug for MemberCatalog {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MemberCatalog")
            .field("member_count", &self.member_count)
            .finish_non_exhaustive()
    }
}

pub(super) struct MemberCatalogBuilder {
    connection: Connection,
    directory: TempDir,
    next_id: u64,
    pending: Vec<DatasetMember>,
}

pub(super) struct MemberPage {
    pub(super) members: Vec<DatasetMember>,
    pub(super) next_ordinal: Option<u64>,
}

impl MemberCatalogBuilder {
    pub(super) fn new() -> Result<Self, DatasetError> {
        let directory = tempfile::tempdir().map_err(map_catalog_error)?;
        let spill = directory.path().join("spill");
        fs::create_dir(&spill).map_err(map_catalog_error)?;
        let spill = spill.to_str().ok_or(DatasetError::Unsupported)?;
        let config = Config::default()
            .max_memory(CATALOG_MEMORY_LIMIT)
            .and_then(|config| config.threads(1))
            .and_then(|config| config.enable_object_cache(false))
            .and_then(|config| config.with("temp_directory", spill))
            .map_err(map_catalog_error)?;
        let connection =
            Connection::open_with_flags(directory.path().join("members.duckdb"), config)
                .map_err(map_catalog_error)?;
        connection
            .execute_batch(
                "SET parquet_metadata_cache = false; SET preserve_insertion_order = true; \
                 CREATE TABLE members (\
                   id UBIGINT PRIMARY KEY, ordinal UBIGINT, path VARCHAR NOT NULL, \
                   relative VARCHAR NOT NULL, size_bytes UBIGINT NOT NULL, \
                   modified_side TINYINT NOT NULL, modified_seconds UBIGINT NOT NULL, \
                   modified_nanos UINTEGER NOT NULL, platform_kind UTINYINT NOT NULL, \
                   platform_a UBIGINT NOT NULL, platform_b UBIGINT NOT NULL, \
                   platform_c UBIGINT NOT NULL, \
                   row_count UBIGINT, drift_rank UBIGINT); \
                 CREATE TABLE partitions (\
                   member_id UBIGINT NOT NULL, position UINTEGER NOT NULL, \
                   key_lower VARCHAR NOT NULL, key VARCHAR NOT NULL, value VARCHAR NOT NULL, \
                   PRIMARY KEY (member_id, position)); \
                 CREATE TABLE inspection_updates (\
                   ordinal UBIGINT PRIMARY KEY, row_count UBIGINT NOT NULL, drift_rank UBIGINT); \
                 CREATE TABLE ordinal_updates (id UBIGINT PRIMARY KEY, ordinal UBIGINT NOT NULL); \
                 CREATE TABLE partition_key_updates (\
                   key_lower VARCHAR NOT NULL, key VARCHAR NOT NULL, \
                   relative VARCHAR NOT NULL, position UINTEGER NOT NULL, \
                   can_be_int64 BOOLEAN NOT NULL, has_value BOOLEAN NOT NULL); \
                 CREATE TABLE partition_keys (\
                   key_lower VARCHAR PRIMARY KEY, key VARCHAR NOT NULL, \
                   first_relative VARCHAR NOT NULL, first_position UINTEGER NOT NULL, \
                   can_be_int64 BOOLEAN NOT NULL, has_value BOOLEAN NOT NULL); \
                 CREATE UNIQUE INDEX members_ordinal ON members(ordinal); \
                 CREATE UNIQUE INDEX members_relative ON members(relative); \
                 CREATE UNIQUE INDEX members_path ON members(path); \
                 CREATE INDEX members_platform ON members(\
                   platform_kind, platform_a, platform_b, platform_c)",
            )
            .map_err(map_catalog_error)?;
        Ok(Self {
            connection,
            directory,
            next_id: 0,
            pending: Vec::with_capacity(CATALOG_PAGE_MEMBERS as usize),
        })
    }

    pub(super) fn push(&mut self, member: DatasetMember) -> Result<(), DatasetError> {
        self.pending.push(member);
        if self.pending.len() == CATALOG_PAGE_MEMBERS as usize {
            self.flush()?;
        }
        Ok(())
    }

    pub(super) fn member_count(&self) -> Result<u64, DatasetError> {
        self.next_id
            .checked_add(self.pending.len() as u64)
            .ok_or(DatasetError::Unsupported)
    }

    #[cfg(test)]
    pub(super) fn pending_member_count(&self) -> usize {
        self.pending.len()
    }

    fn flush(&mut self) -> Result<(), DatasetError> {
        if self.pending.is_empty() {
            return Ok(());
        }
        self.connection
            .execute_batch("BEGIN TRANSACTION")
            .map_err(map_catalog_error)?;
        let result = self.flush_transaction();
        let finish = if result.is_ok() { "COMMIT" } else { "ROLLBACK" };
        self.connection
            .execute_batch(finish)
            .map_err(map_catalog_error)?;
        result
    }

    fn flush_transaction(&mut self) -> Result<(), DatasetError> {
        let mut members = self
            .connection
            .appender("members")
            .map_err(map_catalog_error)?;
        for member in &self.pending {
            let id = self.next_id;
            self.next_id = self
                .next_id
                .checked_add(1)
                .ok_or(DatasetError::Unsupported)?;
            let path = member
                .path
                .to_str()
                .ok_or(DatasetError::Unsupported)?
                .to_owned();
            let (modified_side, modified_seconds, modified_nanos) =
                encode_system_time(member.identity.modified);
            let (platform_kind, platform_a, platform_b, platform_c) =
                encode_platform(member.identity.platform);
            members
                .append_row(appender_params_from_iter([
                    Value::UBigInt(id),
                    Value::Null,
                    Value::Text(path),
                    Value::Text(member.relative_path.clone()),
                    Value::UBigInt(member.identity.size_bytes),
                    Value::TinyInt(modified_side),
                    Value::UBigInt(modified_seconds),
                    Value::UInt(modified_nanos),
                    Value::UTinyInt(platform_kind),
                    Value::UBigInt(platform_a),
                    Value::UBigInt(platform_b),
                    Value::UBigInt(platform_c),
                    Value::Null,
                    Value::Null,
                ]))
                .map_err(map_catalog_error)?;
        }
        members.flush().map_err(map_catalog_error)?;
        drop(members);

        let first_id = self
            .next_id
            .checked_sub(self.pending.len() as u64)
            .ok_or(DatasetError::Unsupported)?;
        let mut partitions = self
            .connection
            .appender("partitions")
            .map_err(map_catalog_error)?;
        for (member_offset, member) in self.pending.iter().enumerate() {
            let id = first_id
                .checked_add(member_offset as u64)
                .ok_or(DatasetError::Unsupported)?;
            for (position, partition) in member.partitions.iter().enumerate() {
                partitions
                    .append_row(appender_params_from_iter([
                        Value::UBigInt(id),
                        Value::UInt(
                            u32::try_from(position).map_err(|_| DatasetError::Unsupported)?,
                        ),
                        Value::Text(partition.key.to_ascii_lowercase()),
                        Value::Text(partition.key.clone()),
                        Value::Text(partition.value.clone()),
                    ]))
                    .map_err(map_catalog_error)?;
            }
        }
        partitions.flush().map_err(map_catalog_error)?;
        drop(partitions);
        self.connection
            .execute_batch("DELETE FROM partition_key_updates")
            .map_err(map_catalog_error)?;
        let mut keys = self
            .connection
            .appender("partition_key_updates")
            .map_err(map_catalog_error)?;
        for member in &self.pending {
            for (position, partition) in member.partitions.iter().enumerate() {
                let has_value = partition.value != HIVE_DEFAULT_PARTITION;
                keys.append_row([
                    Value::Text(partition.key.to_ascii_lowercase()),
                    Value::Text(partition.key.clone()),
                    Value::Text(member.relative_path.clone()),
                    Value::UInt(u32::try_from(position).map_err(|_| DatasetError::Unsupported)?),
                    Value::Boolean(
                        !has_value || canonical_partition_i64(&partition.value).is_some(),
                    ),
                    Value::Boolean(has_value),
                ])
                .map_err(map_catalog_error)?;
            }
        }
        keys.flush().map_err(map_catalog_error)?;
        drop(keys);
        self.connection
            .execute_batch(
                "INSERT INTO partition_keys \
                 SELECT key_lower, arg_min(key, struct_pack(relative, position)), \
                        min(relative), arg_min(position, relative), \
                        bool_and(can_be_int64), bool_or(has_value) \
                 FROM partition_key_updates GROUP BY key_lower \
                 ON CONFLICT (key_lower) DO UPDATE SET \
                   key = CASE WHEN excluded.first_relative < partition_keys.first_relative \
                              THEN excluded.key ELSE partition_keys.key END, \
                   first_position = CASE \
                     WHEN excluded.first_relative < partition_keys.first_relative \
                     THEN excluded.first_position ELSE partition_keys.first_position END, \
                   first_relative = least(excluded.first_relative, partition_keys.first_relative), \
                   can_be_int64 = partition_keys.can_be_int64 AND excluded.can_be_int64, \
                   has_value = partition_keys.has_value OR excluded.has_value",
            )
            .map_err(map_catalog_error)?;
        self.pending.clear();
        Ok(())
    }

    pub(super) fn finish_while(
        mut self,
        mut keep_going: impl FnMut() -> bool,
    ) -> Result<MemberCatalog, DatasetError> {
        if !keep_going() {
            return Err(DatasetError::Cancelled);
        }
        self.flush()?;
        let mut after = None::<String>;
        let mut ordinal = 0_u64;
        loop {
            if !keep_going() {
                return Err(DatasetError::Cancelled);
            }
            let (ids, next_after) = {
                let mut statement = self
                    .connection
                    .prepare(
                        "SELECT id, relative FROM members \
                         WHERE (? IS NULL OR relative > ?) \
                         ORDER BY relative LIMIT ?",
                    )
                    .map_err(map_catalog_error)?;
                let after_value = after.clone().map_or(Value::Null, Value::Text);
                let rows = statement
                    .query_map(
                        [
                            after_value.clone(),
                            after_value,
                            Value::UBigInt(u64::from(CATALOG_PAGE_MEMBERS)),
                        ],
                        |row| Ok((row.get::<_, u64>(0)?, row.get::<_, String>(1)?)),
                    )
                    .map_err(map_catalog_error)?;
                let page = rows
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(map_catalog_error)?;
                let next = page.last().map(|(_, relative)| relative.clone());
                (page, next)
            };
            if ids.is_empty() {
                break;
            }
            self.connection
                .execute_batch("BEGIN TRANSACTION; DELETE FROM ordinal_updates")
                .map_err(map_catalog_error)?;
            let result = (|| {
                let mut updates = self
                    .connection
                    .appender("ordinal_updates")
                    .map_err(map_catalog_error)?;
                for (id, _) in &ids {
                    if !keep_going() {
                        return Err(DatasetError::Cancelled);
                    }
                    updates
                        .append_row([Value::UBigInt(*id), Value::UBigInt(ordinal)])
                        .map_err(map_catalog_error)?;
                    ordinal = ordinal.checked_add(1).ok_or(DatasetError::Unsupported)?;
                }
                updates.flush().map_err(map_catalog_error)?;
                drop(updates);
                self.connection
                    .execute_batch(
                        "UPDATE members SET ordinal = u.ordinal FROM ordinal_updates u \
                         WHERE members.id = u.id",
                    )
                    .map_err(map_catalog_error)
            })();
            self.connection
                .execute_batch(if result.is_ok() { "COMMIT" } else { "ROLLBACK" })
                .map_err(map_catalog_error)?;
            result?;
            after = next_after;
        }
        Ok(MemberCatalog {
            connection: Mutex::new(self.connection),
            _directory: self.directory,
            member_count: self.next_id,
            #[cfg(test)]
            member_batch_queries: AtomicUsize::new(0),
            #[cfg(test)]
            target_lookup_queries: AtomicUsize::new(0),
        })
    }
}

impl MemberCatalog {
    pub(super) fn temporary_directory_hint(&self) -> &Path {
        self._directory.path()
    }

    pub(super) fn member_count(&self) -> u64 {
        self.member_count
    }

    pub(super) fn contains_target(
        &self,
        path: &Path,
        platform: Option<&PlatformFileIdentity>,
    ) -> Result<bool, DatasetError> {
        #[cfg(test)]
        self.target_lookup_queries.fetch_add(1, Ordering::Relaxed);
        let path = path.to_str().ok_or(DatasetError::Unsupported)?;
        let (kind, first, second, third) = platform.copied().map_or((0, 0, 0, 0), encode_platform);
        self.connection
            .lock()
            .map_err(|_| DatasetError::Unsupported)?
            .query_row(
                "SELECT EXISTS (\
                   SELECT 1 FROM (\
                     SELECT id FROM members WHERE path = ? \
                     UNION ALL \
                     SELECT id FROM members WHERE ? <> 0 \
                       AND platform_kind = ? AND platform_a = ? \
                       AND platform_b = ? AND platform_c = ?\
                   ) matches LIMIT 1)",
                params_from_iter([
                    Value::Text(path.to_owned()),
                    Value::UTinyInt(kind),
                    Value::UTinyInt(kind),
                    Value::UBigInt(first),
                    Value::UBigInt(second),
                    Value::UBigInt(third),
                ]),
                |row| row.get(0),
            )
            .map_err(map_catalog_error)
    }

    #[cfg(test)]
    pub(super) fn target_lookup_query_count(&self) -> usize {
        self.target_lookup_queries.load(Ordering::Relaxed)
    }

    pub(super) fn partition_page(
        &self,
        parent: &[PartitionValue],
        after: Option<&PartitionValue>,
        limit: u32,
    ) -> Result<DatasetPartitionPage, DatasetError> {
        if limit > CATALOG_PAGE_MEMBERS {
            return Err(DatasetError::PageTooLarge);
        }
        if limit == 0 {
            return Ok(DatasetPartitionPage {
                nodes: Vec::new(),
                next_after: None,
            });
        }
        let mut predicates = Vec::with_capacity(parent.len());
        let mut parameters = Vec::with_capacity(parent.len() * 3 + 5);
        parameters.push(Value::UInt(
            u32::try_from(parent.len()).map_err(|_| DatasetError::PageTooLarge)?,
        ));
        for (position, partition) in parent.iter().enumerate() {
            predicates.push(
                "EXISTS (SELECT 1 FROM partitions parent_partition \
                 WHERE parent_partition.member_id = child.member_id \
                 AND parent_partition.position = ? \
                 AND parent_partition.key_lower = ? \
                 AND parent_partition.value = ?)"
                    .to_owned(),
            );
            parameters.push(Value::UInt(
                u32::try_from(position).map_err(|_| DatasetError::PageTooLarge)?,
            ));
            parameters.push(Value::Text(partition.key.to_ascii_lowercase()));
            parameters.push(Value::Text(partition.value.clone()));
        }
        if let Some(after) = after {
            predicates.push(
                "(child.key_lower > ? OR \
                 (child.key_lower = ? AND child.value > ?))"
                    .to_owned(),
            );
            let after_key_lower = after.key.to_ascii_lowercase();
            parameters.push(Value::Text(after_key_lower.clone()));
            parameters.push(Value::Text(after_key_lower));
            parameters.push(Value::Text(after.value.clone()));
        }
        parameters.push(Value::UBigInt(u64::from(limit) + 1));
        let where_clause = if predicates.is_empty() {
            String::new()
        } else {
            format!(" AND {}", predicates.join(" AND "))
        };
        let connection = self
            .connection
            .lock()
            .map_err(|_| DatasetError::Unsupported)?;
        let mut statement = connection
            .prepare(&format!(
                "SELECT arg_min(child.key, member.ordinal), child.value, count(*)::UBIGINT \
                 FROM partitions child JOIN members member ON member.id = child.member_id \
                 WHERE child.position = ?{where_clause} \
                 GROUP BY child.key_lower, child.value \
                 ORDER BY child.key_lower, child.value LIMIT ?"
            ))
            .map_err(map_catalog_error)?;
        let rows = statement
            .query_map(params_from_iter(parameters), |row| {
                Ok(DatasetPartitionNode {
                    partition: PartitionValue {
                        key: row.get(0)?,
                        value: row.get(1)?,
                    },
                    member_count: row.get(2)?,
                })
            })
            .map_err(map_catalog_error)?;
        let mut nodes = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(map_catalog_error)?;
        let has_next = nodes.len() > limit as usize;
        if has_next {
            nodes.pop();
        }
        let next_after = has_next
            .then(|| nodes.last().map(|node| node.partition.clone()))
            .flatten();
        Ok(DatasetPartitionPage { nodes, next_after })
    }

    pub(super) fn member(&self, ordinal: u64) -> Result<Option<DatasetMember>, DatasetError> {
        Ok(self.members(&[ordinal])?.pop())
    }

    pub(super) fn members(&self, ordinals: &[u64]) -> Result<Vec<DatasetMember>, DatasetError> {
        if ordinals.len() > CATALOG_PAGE_MEMBERS as usize {
            return Err(DatasetError::PageTooLarge);
        }
        if ordinals.is_empty() {
            return Ok(Vec::new());
        }
        #[cfg(test)]
        self.member_batch_queries.fetch_add(1, Ordering::Relaxed);
        let placeholders = std::iter::repeat_n("?", ordinals.len())
            .collect::<Vec<_>>()
            .join(", ");
        let connection = self
            .connection
            .lock()
            .map_err(|_| DatasetError::Unsupported)?;
        let mut statement = connection
            .prepare(&format!(
                "SELECT m.id, m.ordinal, m.path, m.relative, m.size_bytes, m.modified_side, \
                        m.modified_seconds, m.modified_nanos, m.platform_kind, \
                        m.platform_a, m.platform_b, m.platform_c, m.row_count, \
                        p.position, p.key, p.value \
                 FROM members m LEFT JOIN partitions p ON p.member_id = m.id \
                 WHERE m.ordinal IN ({placeholders}) ORDER BY m.ordinal, p.position"
            ))
            .map_err(map_catalog_error)?;
        let values = ordinals.iter().copied().map(Value::UBigInt);
        let mut rows = statement
            .query(params_from_iter(values))
            .map_err(map_catalog_error)?;
        let mut members = Vec::<DatasetMember>::with_capacity(ordinals.len());
        let mut bytes = 0_usize;
        while let Some(row) = rows.next().map_err(map_catalog_error)? {
            let ordinal = row.get::<_, u64>(1).map_err(map_query_error)?;
            if members
                .last()
                .is_none_or(|member| member.ordinal != ordinal)
            {
                let path = row.get::<_, String>(2).map_err(map_query_error)?;
                let relative_path = row.get::<_, String>(3).map_err(map_query_error)?;
                bytes = bytes
                    .checked_add(path.len())
                    .and_then(|bytes| bytes.checked_add(relative_path.len()))
                    .filter(|bytes| *bytes <= CATALOG_PAGE_BYTES)
                    .ok_or(DatasetError::PageTooLarge)?;
                members.push(DatasetMember {
                    ordinal,
                    path: PathBuf::from(path),
                    relative_path,
                    partitions: Vec::new(),
                    identity: MemberIdentity {
                        size_bytes: row.get::<_, u64>(4).map_err(map_query_error)?,
                        modified: decode_system_time(
                            row.get::<_, i8>(5).map_err(map_query_error)?,
                            row.get::<_, u64>(6).map_err(map_query_error)?,
                            row.get::<_, u32>(7).map_err(map_query_error)?,
                        )?,
                        platform: decode_platform(
                            row.get::<_, u8>(8).map_err(map_query_error)?,
                            row.get::<_, u64>(9).map_err(map_query_error)?,
                            row.get::<_, u64>(10).map_err(map_query_error)?,
                            row.get::<_, u64>(11).map_err(map_query_error)?,
                        )?,
                    },
                    row_count: row.get::<_, Option<u64>>(12).map_err(map_query_error)?,
                });
            }
            if row
                .get::<_, Option<u32>>(13)
                .map_err(map_query_error)?
                .is_some()
            {
                let key = row.get::<_, String>(14).map_err(map_query_error)?;
                let value = row.get::<_, String>(15).map_err(map_query_error)?;
                bytes = bytes
                    .checked_add(key.len())
                    .and_then(|bytes| bytes.checked_add(value.len()))
                    .filter(|bytes| *bytes <= CATALOG_PAGE_BYTES)
                    .ok_or(DatasetError::PageTooLarge)?;
                members
                    .last_mut()
                    .ok_or(DatasetError::Unsupported)?
                    .partitions
                    .push(PartitionValue { key, value });
            }
        }
        Ok(members)
    }

    #[cfg(test)]
    pub(super) fn member_batch_query_count(&self) -> usize {
        self.member_batch_queries.load(Ordering::Relaxed)
    }

    pub(super) fn page(
        &self,
        after_ordinal: Option<u64>,
        limit: u32,
    ) -> Result<MemberPage, DatasetError> {
        if limit > CATALOG_PAGE_MEMBERS {
            return Err(DatasetError::PageTooLarge);
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| DatasetError::Unsupported)?;
        let after =
            after_ordinal.map_or(-1_i64, |ordinal| i64::try_from(ordinal).unwrap_or(i64::MAX));
        let mut statement = connection
            .prepare(
                "WITH selected AS (\
                   SELECT id, ordinal, path, relative, size_bytes, modified_side, \
                          modified_seconds, modified_nanos, platform_kind, platform_a, platform_b, \
                          platform_c, row_count \
                   FROM members WHERE ordinal > ? ORDER BY ordinal LIMIT ?\
                 ) \
                 SELECT m.id, m.ordinal, m.path, m.relative, m.size_bytes, m.modified_side, \
                        m.modified_seconds, m.modified_nanos, m.platform_kind, \
                        m.platform_a, m.platform_b, m.platform_c, m.row_count, \
                        p.position, p.key, p.value \
                 FROM selected m LEFT JOIN partitions p ON p.member_id = m.id \
                 ORDER BY m.ordinal, p.position",
            )
            .map_err(map_catalog_error)?;
        let mut rows = statement
            .query([Value::BigInt(after), Value::UBigInt(u64::from(limit) + 1)])
            .map_err(map_catalog_error)?;
        let mut members = Vec::<DatasetMember>::with_capacity(limit as usize);
        let mut bytes = 0_usize;
        let mut has_more = false;
        while let Some(row) = rows.next().map_err(map_catalog_error)? {
            let ordinal = row.get::<_, u64>(1).map_err(map_query_error)?;
            let is_new_member = members
                .last()
                .is_none_or(|member| member.ordinal != ordinal);
            if is_new_member && members.len() == limit as usize {
                has_more = true;
                break;
            }
            if is_new_member {
                let path = row.get::<_, String>(2).map_err(map_query_error)?;
                let relative_path = row.get::<_, String>(3).map_err(map_query_error)?;
                let member_bytes = path
                    .len()
                    .checked_add(relative_path.len())
                    .ok_or(DatasetError::Unsupported)?;
                if bytes.saturating_add(member_bytes) > CATALOG_PAGE_BYTES && !members.is_empty() {
                    has_more = true;
                    break;
                }
                bytes = bytes
                    .checked_add(member_bytes)
                    .ok_or(DatasetError::Unsupported)?;
                members.push(DatasetMember {
                    ordinal,
                    path: PathBuf::from(path),
                    relative_path,
                    partitions: Vec::new(),
                    identity: MemberIdentity {
                        size_bytes: row.get::<_, u64>(4).map_err(map_query_error)?,
                        modified: decode_system_time(
                            row.get::<_, i8>(5).map_err(map_query_error)?,
                            row.get::<_, u64>(6).map_err(map_query_error)?,
                            row.get::<_, u32>(7).map_err(map_query_error)?,
                        )?,
                        platform: decode_platform(
                            row.get::<_, u8>(8).map_err(map_query_error)?,
                            row.get::<_, u64>(9).map_err(map_query_error)?,
                            row.get::<_, u64>(10).map_err(map_query_error)?,
                            row.get::<_, u64>(11).map_err(map_query_error)?,
                        )?,
                    },
                    row_count: row.get::<_, Option<u64>>(12).map_err(map_query_error)?,
                });
            }
            let partition_position = row.get::<_, Option<u32>>(13).map_err(map_query_error)?;
            if partition_position.is_some() {
                let key = row.get::<_, String>(14).map_err(map_query_error)?;
                let value = row.get::<_, String>(15).map_err(map_query_error)?;
                bytes = bytes
                    .checked_add(key.len())
                    .and_then(|bytes| bytes.checked_add(value.len()))
                    .ok_or(DatasetError::Unsupported)?;
                members
                    .last_mut()
                    .ok_or(DatasetError::Unsupported)?
                    .partitions
                    .push(PartitionValue { key, value });
            }
        }
        let next_ordinal = has_more
            .then(|| members.last().map(|member| member.ordinal))
            .flatten();
        Ok(MemberPage {
            members,
            next_ordinal,
        })
    }

    pub(super) fn record_inspection_batch(
        &self,
        facts: &[(u64, u64, Option<u64>)],
    ) -> Result<(), DatasetError> {
        if facts.len() > CATALOG_PAGE_MEMBERS as usize {
            return Err(DatasetError::InspectionStepTooLarge);
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| DatasetError::Unsupported)?;
        connection
            .execute_batch("BEGIN TRANSACTION; DELETE FROM inspection_updates")
            .map_err(map_catalog_error)?;
        let result = (|| {
            let mut appender = connection
                .appender("inspection_updates")
                .map_err(map_catalog_error)?;
            for (ordinal, row_count, drift_rank) in facts {
                appender
                    .append_row([
                        Value::UBigInt(*ordinal),
                        Value::UBigInt(*row_count),
                        drift_rank.map_or(Value::Null, Value::UBigInt),
                    ])
                    .map_err(map_catalog_error)?;
            }
            appender.flush().map_err(map_catalog_error)?;
            drop(appender);
            connection
                .execute_batch(
                    "UPDATE members SET row_count = u.row_count, drift_rank = u.drift_rank \
                     FROM inspection_updates u WHERE members.ordinal = u.ordinal",
                )
                .map_err(map_catalog_error)
        })();
        let finish = if result.is_ok() { "COMMIT" } else { "ROLLBACK" };
        connection
            .execute_batch(finish)
            .map_err(map_catalog_error)?;
        result
    }

    pub(super) fn row_offset(&self, ordinal: u64) -> Result<u64, DatasetError> {
        self.connection
            .lock()
            .map_err(|_| DatasetError::Unsupported)?
            .query_row(
                "SELECT coalesce(sum(row_count), 0)::UBIGINT FROM members WHERE ordinal < ?",
                [Value::UBigInt(ordinal)],
                |row| row.get(0),
            )
            .map_err(map_catalog_error)
    }

    pub(super) fn row_counts(&self, ordinals: &[u64]) -> Result<Vec<(u64, u64)>, DatasetError> {
        if ordinals.len() > CATALOG_PAGE_MEMBERS as usize {
            return Err(DatasetError::PageTooLarge);
        }
        if ordinals.is_empty() {
            return Ok(Vec::new());
        }
        let placeholders = std::iter::repeat_n("?", ordinals.len())
            .collect::<Vec<_>>()
            .join(", ");
        let connection = self
            .connection
            .lock()
            .map_err(|_| DatasetError::Unsupported)?;
        let mut statement = connection
            .prepare(&format!(
                "SELECT ordinal, row_count FROM members WHERE ordinal IN ({placeholders})"
            ))
            .map_err(map_catalog_error)?;
        let values = ordinals.iter().copied().map(Value::UBigInt);
        let rows = statement
            .query_map(params_from_iter(values), |row| {
                Ok((row.get::<_, u64>(0)?, row.get::<_, u64>(1)?))
            })
            .map_err(map_catalog_error)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(map_catalog_error)
    }

    pub(super) fn row_count_page(
        &self,
        after_ordinal: Option<u64>,
        limit: u32,
    ) -> Result<(u64, Option<u64>), DatasetError> {
        if limit > CATALOG_PAGE_MEMBERS {
            return Err(DatasetError::PageTooLarge);
        }
        let after =
            after_ordinal.map_or(-1_i64, |ordinal| i64::try_from(ordinal).unwrap_or(i64::MAX));
        let (row_count, last): (u64, Option<u64>) = self
            .connection
            .lock()
            .map_err(|_| DatasetError::Unsupported)?
            .query_row(
                "SELECT coalesce(sum(row_count), 0)::UBIGINT, max(ordinal)::UBIGINT \
                 FROM (SELECT ordinal, row_count FROM members \
                       WHERE ordinal > ? ORDER BY ordinal LIMIT ?)",
                [Value::BigInt(after), Value::UBigInt(u64::from(limit))],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(map_catalog_error)?;
        let next = last.filter(|ordinal| ordinal.saturating_add(1) < self.member_count);
        Ok((row_count, next))
    }

    pub(super) fn drift_page(
        &self,
        offset: u64,
        limit: u32,
    ) -> Result<(u64, Vec<DatasetMember>), DatasetError> {
        if limit > CATALOG_PAGE_MEMBERS {
            return Err(DatasetError::PageTooLarge);
        }
        let connection = self.connection.lock().map_err(map_catalog_error)?;
        let total = connection
            .query_row(
                "SELECT count(*)::UBIGINT FROM members WHERE drift_rank IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .map_err(map_catalog_error)?;
        let ordinals = {
            let mut statement = connection
                .prepare(
                    "SELECT ordinal FROM members WHERE drift_rank >= ? \
                     ORDER BY drift_rank LIMIT ?",
                )
                .map_err(map_catalog_error)?;
            let rows = statement
                .query_map(
                    [Value::UBigInt(offset), Value::UBigInt(u64::from(limit))],
                    |row| row.get::<_, u64>(0),
                )
                .map_err(map_catalog_error)?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(map_catalog_error)?
        };
        drop(connection);
        let members = ordinals
            .into_iter()
            .map(|ordinal| self.member(ordinal)?.ok_or(DatasetError::Unsupported))
            .collect::<Result<Vec<_>, _>>()?;
        Ok((total, members))
    }

    pub(super) fn partition_columns(&self) -> Result<Vec<PartitionColumn>, DatasetError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| DatasetError::Unsupported)?;
        let (count, bytes): (i64, i64) = connection
            .query_row(
                "SELECT count(*)::BIGINT, \
                        coalesce(sum(octet_length(encode(key))), 0)::BIGINT FROM partition_keys",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(map_catalog_error)?;
        if count < 0
            || bytes < 0
            || count as usize > MAX_DATASET_SCHEMA_NODES
            || bytes as usize > MAX_DATASET_SCHEMA_BYTES
        {
            return Err(DatasetError::Unsupported);
        }
        let mut statement = connection
            .prepare(
                "SELECT key, can_be_int64 AND has_value FROM partition_keys \
                 ORDER BY first_relative, first_position, key_lower, key",
            )
            .map_err(map_catalog_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok(PartitionColumn {
                    name: row.get(0)?,
                    kind: if row.get(1)? {
                        PartitionColumnKind::Int64
                    } else {
                        PartitionColumnKind::Text
                    },
                })
            })
            .map_err(map_catalog_error)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(map_catalog_error)
    }
}

fn encode_system_time(value: Option<SystemTime>) -> (i8, u64, u32) {
    let Some(value) = value else {
        return (0, 0, 0);
    };
    match value.duration_since(UNIX_EPOCH) {
        Ok(duration) => (1, duration.as_secs(), duration.subsec_nanos()),
        Err(error) => {
            let duration = error.duration();
            (-1, duration.as_secs(), duration.subsec_nanos())
        }
    }
}

fn decode_system_time(
    side: i8,
    seconds: u64,
    nanos: u32,
) -> Result<Option<SystemTime>, DatasetError> {
    let duration = Duration::new(seconds, nanos);
    match side {
        0 => Ok(None),
        1 => UNIX_EPOCH
            .checked_add(duration)
            .map(Some)
            .ok_or(DatasetError::Unsupported),
        -1 => UNIX_EPOCH
            .checked_sub(duration)
            .map(Some)
            .ok_or(DatasetError::Unsupported),
        _ => Err(DatasetError::Unsupported),
    }
}

fn encode_platform(value: PlatformFileIdentity) -> (u8, u64, u64, u64) {
    match value {
        #[cfg(unix)]
        PlatformFileIdentity::Unix { device, inode } => (1, device, inode, 0),
        #[cfg(windows)]
        PlatformFileIdentity::Windows {
            volume_serial_number,
            file_id,
        } => {
            let (file_id_low, file_id_high) = encode_windows_file_id(file_id);
            (2, volume_serial_number, file_id_low, file_id_high)
        }
        #[cfg(not(any(unix, windows)))]
        PlatformFileIdentity::Unavailable => (0, 0, 0, 0),
    }
}

fn decode_platform(
    kind: u8,
    first: u64,
    second: u64,
    _third: u64,
) -> Result<PlatformFileIdentity, DatasetError> {
    match kind {
        #[cfg(unix)]
        1 => Ok(PlatformFileIdentity::Unix {
            device: first,
            inode: second,
        }),
        #[cfg(windows)]
        2 => Ok(PlatformFileIdentity::Windows {
            volume_serial_number: first,
            file_id: decode_windows_file_id(second, _third),
        }),
        #[cfg(not(any(unix, windows)))]
        0 => Ok(PlatformFileIdentity::Unavailable),
        _ => Err(DatasetError::Unsupported),
    }
}

#[cfg(any(test, windows))]
fn encode_windows_file_id(file_id: [u8; 16]) -> (u64, u64) {
    let mut low = [0; 8];
    low.copy_from_slice(&file_id[..8]);
    let mut high = [0; 8];
    high.copy_from_slice(&file_id[8..]);
    (u64::from_le_bytes(low), u64::from_le_bytes(high))
}

#[cfg(any(test, windows))]
fn decode_windows_file_id(low: u64, high: u64) -> [u8; 16] {
    let mut file_id = [0; 16];
    file_id[..8].copy_from_slice(&low.to_le_bytes());
    file_id[8..].copy_from_slice(&high.to_le_bytes());
    file_id
}

fn map_query_error(error: DuckDbError) -> DatasetError {
    map_catalog_error(error)
}

fn map_catalog_error(error: impl fmt::Display) -> DatasetError {
    let message = error.to_string().to_ascii_lowercase();
    if [
        "out of memory",
        "memory limit",
        "failed to allocate",
        "no space left",
        "disk full",
        "temp directory",
    ]
    .iter()
    .any(|marker| message.contains(marker))
    {
        DatasetError::Window {
            error: DataWindowError::ResourceExhausted,
        }
    } else {
        DatasetError::Unsupported
    }
}

#[cfg(test)]
mod tests {
    use super::{
        CATALOG_PAGE_MEMBERS, DatasetError, DatasetMember, MemberCatalogBuilder, MemberIdentity,
        PartitionValue, decode_platform, decode_windows_file_id, encode_windows_file_id,
    };

    #[test]
    fn partition_pages_keep_non_ascii_keys_distinct_under_ascii_identity() {
        let mut builder = MemberCatalogBuilder::new().expect("member catalog");
        let platform_kind = if cfg!(unix) {
            1
        } else if cfg!(windows) {
            2
        } else {
            0
        };
        for (relative_path, key, day) in [("a.parquet", "Σ", "1"), ("b.parquet", "σ", "2")] {
            builder
                .push(DatasetMember {
                    ordinal: 0,
                    path: relative_path.into(),
                    relative_path: relative_path.to_owned(),
                    partitions: vec![
                        PartitionValue {
                            key: key.to_owned(),
                            value: "shared".to_owned(),
                        },
                        PartitionValue {
                            key: "day".to_owned(),
                            value: day.to_owned(),
                        },
                    ],
                    identity: MemberIdentity {
                        size_bytes: 0,
                        modified: None,
                        platform: decode_platform(platform_kind, 0, 0, 0)
                            .expect("test platform identity"),
                    },
                    row_count: None,
                })
                .expect("catalog member");
        }
        let catalog = builder.finish_while(|| true).expect("finished catalog");

        let first = catalog
            .partition_page(&[], None, 1)
            .expect("first root page");
        assert_eq!(first.nodes.len(), 1);
        let cursor = first.next_after.as_ref().expect("root cursor");
        let second = catalog
            .partition_page(&[], Some(cursor), 1)
            .expect("second root page");
        assert_eq!(second.nodes.len(), 1);
        assert_eq!(second.next_after, None);
        let root_keys = first
            .nodes
            .iter()
            .chain(&second.nodes)
            .map(|node| (node.partition.key.as_str(), node.member_count))
            .collect::<Vec<_>>();
        assert_eq!(root_keys, [("Σ", 1), ("σ", 1)]);

        for (key, expected_day) in [("Σ", "1"), ("σ", "2")] {
            let children = catalog
                .partition_page(
                    &[PartitionValue {
                        key: key.to_owned(),
                        value: "shared".to_owned(),
                    }],
                    None,
                    16,
                )
                .expect("exact ASCII-key parent");
            assert_eq!(
                children
                    .nodes
                    .iter()
                    .map(|node| node.partition.value.as_str())
                    .collect::<Vec<_>>(),
                [expected_day]
            );
        }
    }

    #[test]
    fn windows_file_id_storage_roundtrips_all_bytes() {
        let file_id = [
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd,
            0xee, 0xff,
        ];

        let (low, high) = encode_windows_file_id(file_id);

        assert_eq!(decode_windows_file_id(low, high), file_id);
    }

    #[test]
    fn drift_pages_use_the_persisted_catalog_order_and_page_limit() {
        let mut builder = MemberCatalogBuilder::new().expect("member catalog");
        let platform_kind = if cfg!(unix) {
            1
        } else if cfg!(windows) {
            2
        } else {
            0
        };
        for ordinal in 0..300_u64 {
            let relative_path = format!("part-{ordinal:03}.parquet");
            builder
                .push(DatasetMember {
                    ordinal: 0,
                    path: relative_path.clone().into(),
                    relative_path,
                    partitions: Vec::new(),
                    identity: MemberIdentity {
                        size_bytes: 0,
                        modified: None,
                        platform: decode_platform(platform_kind, 0, 0, 0)
                            .expect("test platform identity"),
                    },
                    row_count: None,
                })
                .expect("catalog member");
        }
        let catalog = builder.finish_while(|| true).expect("finished catalog");
        let facts = (0..300_u64)
            .map(|ordinal| (ordinal, ordinal + 1, Some(ordinal)))
            .collect::<Vec<_>>();
        for page in facts.chunks(CATALOG_PAGE_MEMBERS as usize) {
            catalog
                .record_inspection_batch(page)
                .expect("inspection facts");
        }

        let (total, page) = catalog.drift_page(255, 2).expect("drift page");
        assert_eq!(total, 300);
        assert_eq!(
            page.iter()
                .map(|member| (member.ordinal, member.relative_path.as_str()))
                .collect::<Vec<_>>(),
            [(255, "part-255.parquet"), (256, "part-256.parquet")]
        );
        let (total_after_end, after_end) = catalog.drift_page(300, 2).expect("page after end");
        assert_eq!(total_after_end, 300);
        assert!(after_end.is_empty());
        assert!(matches!(
            catalog.drift_page(0, CATALOG_PAGE_MEMBERS + 1),
            Err(DatasetError::PageTooLarge)
        ));
    }
}
