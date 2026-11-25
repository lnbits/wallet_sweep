use crate::{host, input::*, Reply};
use serde_json::{json, Value};

pub fn save(table: &str, v: &Value, fields: Value) -> Result<(), String> {
    let mut row = json!({"id":v["id"],"created_at":v["createdAt"],"data_json":v.to_string()});
    if let (Some(row), Value::Object(extra)) = (row.as_object_mut(), fields) {
        row.extend(extra);
    }
    host::set(table, &row)
}
pub fn load(table: &str, id: &str) -> Reply {
    let row = host::get(table, id)?;
    if row.is_null() {
        return Err("The requested record was not found in your account.".into());
    }
    decode(&row)
}
pub fn decode(row: &Value) -> Reply {
    serde_json::from_str(s(&row["data_json"])).map_err(|_| "Invalid stored sweep record.".into())
}
pub fn payouts(plan: &Value) -> Result<Vec<Value>, String> {
    let p = host::page(
        "payouts",
        json!({"filters":{"plan_id":plan["id"]},"limit":2}),
    )?;
    if p.total > 1 {
        return Err("Concurrent payment preparation detected. Keep funds in the wallet and review its history.".into());
    }
    p.rows.iter().map(decode).collect()
}
pub fn hide_invoice(row: &Value) -> Value {
    let mut row = row.clone();
    if let Some(v) = row.as_object_mut() {
        v.remove("invoice");
    }
    row
}
pub fn start(plan: &Value, step: &str) -> Reply {
    let attempt = json!({"id":host::id("attempt_"),"createdAt":host::now(),"status":"uncertain","error":"Payment started; settlement is not confirmed.","planId":plan["id"],"step":step});
    finish(&attempt)?;
    Ok(attempt)
}
pub fn finish(attempt: &Value) -> Result<(), String> {
    save(
        "receipts",
        attempt,
        json!({"plan_id":attempt["planId"],"step":attempt["step"]}),
    )
}
pub fn view(plan: &Value) -> Reply {
    let p = host::page(
        "receipts",
        json!({"filters":{"plan_id":plan["id"]},"limit":1000}),
    )?;
    if p.total > 1000 {
        return Err("This sweep requires manual review in the wallet payment history.".into());
    }
    let receipts = p
        .rows
        .iter()
        .map(|r| {
            let mut v = decode(r)?;
            v["step"] = r["step"].clone();
            Ok(v)
        })
        .collect::<Result<Vec<_>, String>>()?;
    let mut moved = 0;
    let mut partial = false;
    let mut sources = Vec::new();
    for row in plan["sources"].as_array().ok_or("Invalid sweep sources.")? {
        let mut source = hide_invoice(row);
        let (status, receipt) = state(&receipts, &format!("source:{}", s(&row["sourceId"])));
        let status = if row["skippedReason"].is_string() {
            "skipped"
        } else {
            status
        };
        source["status"] = json!(status);
        source["receipt"] = receipt.clone();
        let amt = amount(&row["amountSat"], "Amount")?;
        if status == "success" {
            moved += amt;
        }
        if status == "failed" && amt > 0 {
            partial = true;
        }
        sources.push(source);
    }
    let tickets = payouts(plan)?;
    let payout = tickets.first().map(|t| {
        let (status, receipt) = state(&receipts, &format!("payout:{}", s(&t["id"])));
        let mut row = hide_invoice(t);
        row["status"] = json!(status);
        row["receipt"] = receipt.clone();
        row
    });
    let mut result = plan.clone();
    result["sources"] = json!(sources);
    result["movedSat"] = json!(moved);
    result["partial"] = json!(partial);
    result["payoutCount"] = json!(tickets.len());
    result["payout"] = json!(payout);
    Ok(result)
}
fn state<'a>(receipts: &'a [Value], step: &str) -> (&'static str, &'a Value) {
    for status in ["success", "uncertain", "failed"] {
        if let Some(r) = receipts
            .iter()
            .find(|r| r["step"] == step && r["status"] == status)
        {
            return (status, r);
        }
    }
    ("ready", &Value::Null)
}
