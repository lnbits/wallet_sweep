use crate::lnbits::extension::host as wit;
use serde_json::{json, Value};

pub fn now() -> u64 {
    wit::now().timestamp
}

pub fn id(prefix: &str) -> String {
    wit::random_id(&wit::RandomRequest {
        prefix: prefix.into(),
    })
    .id
}

pub fn get(table: &str, id: &str) -> Result<Value, String> {
    let r = wit::storage_get(&wit::StorageGetRequest {
        table: table.into(),
        id: id.into(),
    });
    match r.data_json {
        None => Ok(Value::Null),
        Some(s) => serde_json::from_str(&s).map_err(|_| "Invalid stored row.".into()),
    }
}

pub fn set(table: &str, row: &Value) -> Result<(), String> {
    let r = wit::storage_set(&wit::StorageSetRequest {
        table: table.into(),
        data_json: row.to_string(),
    });
    if r.ok {
        Ok(())
    } else {
        Err("Could not save row.".into())
    }
}

pub struct Page {
    pub rows: Vec<Value>,
    pub total: u64,
}

pub fn page(table: &str, options: Value) -> Result<Page, String> {
    let r = wit::storage_get_paginated(&wit::StoragePaginatedRequest {
        table: table.into(),
        filters_json: options
            .get("filters")
            .map(Value::to_string)
            .unwrap_or_else(|| "{}".into()),
        search: options["search"].as_str().unwrap_or_default().into(),
        search_fields: options["searchFields"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(String::from)
            .collect(),
        sort_by: options["sortBy"].as_str().unwrap_or_default().into(),
        descending: options["descending"] == true,
        limit: options["limit"].as_u64().unwrap_or(25) as u32,
        offset: options["offset"].as_u64().unwrap_or(0) as u32,
    });
    Ok(Page {
        rows: serde_json::from_str(&r.rows_json).map_err(|_| "Invalid stored rows.")?,
        total: r.total,
    })
}

pub fn wallets() -> Vec<Value> {
    wit::list_user_wallets()
        .wallets
        .into_iter()
        .map(|w| {
            let mut r = json!({"id":w.id,"name":w.name});
            if let Some(c) = w.currency {
                r["currency"] = c.into();
            }
            r
        })
        .collect()
}
