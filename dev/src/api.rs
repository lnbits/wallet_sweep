use crate::{
    host,
    input::*,
    ledger,
    lnbits::extension::{host as wit, utils_lnurl},
    Reply,
};
use serde_json::{json, Value};
use std::collections::BTreeSet;

pub fn get_wallets(_: &Value) -> Reply {
    Ok(json!({"wallets":host::wallets(),"maxSources":50}))
}
pub fn get_balance(r: &Value) -> Reply {
    balance(id(&r["walletId"], "Wallet")?)
}
pub fn create_quote(r: &Value) -> Reply {
    let source = id(&r["sourceId"], "Source wallet")?;
    let dest = id(&r["destinationId"], "Destination wallet")?;
    if source == dest {
        return Err("The destination cannot be a source.".into());
    }
    let leave = optional_amount(&r["leaveSat"], "Leave-behind amount")?;
    let from = balance(source)?;
    let to = balance(dest)?;
    let msat = integer(&from["balanceMsat"])?;
    let mut sat = (msat / 1000 - leave).max(0);
    let quote = host::id("quote_");
    let created = host::now();
    let expiry = host::now() + 900;
    let (invoice, hash, reason) = if from["canSendPayments"] != true {
        sat = 0;
        (
            None,
            None,
            Some("This wallet is unavailable for Lightning spending."),
        )
    } else if sat == 0 {
        (
            None,
            None,
            Some("No whole sats available above the retained amount."),
        )
    } else {
        let p = wit::create_invoice(&wit::InvoiceRequest {
            wallet_id: dest.into(),
            amount: sat as f64,
            currency: "sat".into(),
            memo: "Wallet Sweep internal transfer".into(),
            tag: "wallet_sweep".into(),
            extra: vec![
                ("quote_id".into(), quote.clone()),
                ("source_wallet".into(), source.into()),
            ],
        });
        if p.payment_request.is_empty() || p.payment_hash.is_empty() {
            return Err("Could not prepare the internal invoice.".into());
        }
        (Some(p.payment_request), Some(p.payment_hash), None)
    };
    let row = json!({"id":quote,"createdAt":created,"sourceId":source,"sourceName":from["name"],"destinationId":dest,"destinationName":to["name"],
        "balanceMsat":msat,"leaveSat":leave,"amountSat":sat,"retainedMsat":msat-sat*1000,"expiresAt":expiry,"invoice":invoice,"paymentHash":hash,"skippedReason":reason});
    ledger::save("quotes", &row, Value::Null)?;
    Ok(ledger::hide_invoice(&row))
}
pub fn create_plan(r: &Value) -> Reply {
    let ids = r["quoteIds"]
        .as_array()
        .filter(|ids| (1..=50).contains(&ids.len()))
        .ok_or("Select between 1 and 50 source wallets.")?;
    let quotes = ids
        .iter()
        .map(|q| ledger::load("quotes", id(q, "Quote")?))
        .collect::<Result<Vec<_>, _>>()?;
    let first = &quotes[0];
    let mut seen = BTreeSet::new();
    let mut total = 0;
    let mut expiry = u64::MAX;
    for q in &quotes {
        if !seen.insert(s(&q["sourceId"])) {
            return Err("A source wallet was selected twice.".into());
        }
        if q["destinationId"] != first["destinationId"] {
            return Err("All sources must use the same destination.".into());
        }
        let end = q["expiresAt"].as_u64().unwrap_or(0);
        if end <= host::now() {
            return Err("The preview expired. Create a new preview.".into());
        }
        expiry = expiry.min(end);
        total = amount(&json!(total + amount(&q["amountSat"], "Total")?), "Total")?;
    }
    if total == 0 {
        return Err("There are no funds available to consolidate.".into());
    }
    let address = if r["address"].is_null() || r["address"] == "" {
        String::new()
    } else {
        let a = address(&r["address"])?;
        resolve(&a);
        a
    };
    let plan = json!({"id":host::id("sweep_"),"createdAt":host::now(),"destinationId":first["destinationId"],"destinationName":first["destinationName"],"address":address,"sources":quotes,"totalSat":total,"expiresAt":expiry});
    ledger::save("plans", &plan, Value::Null)?;
    ledger::view(&plan)
}
pub fn get_plan(r: &Value) -> Reply {
    ledger::view(&plan(r)?)
}
pub fn get_history(r: &Value) -> Reply {
    let offset = if let Some(s) = r["offset"]
        .as_str()
        .filter(|s| s.len() <= 8 && !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit()))
    {
        s.parse::<i64>().map_err(|_| "Invalid offset.")?
    } else {
        optional_amount(&r["offset"], "Offset")?
    };
    let p = host::page(
        "plans",
        json!({"sortBy":"created_at","descending":true,"limit":20,"offset":offset.min(u32::MAX.into())}),
    )?;
    let plans=p.rows.iter().map(|row|{let plan=ledger::decode(row)?;Ok(json!({"id":plan["id"],"createdAt":plan["createdAt"],"destinationName":plan["destinationName"],"address":plan["address"],"totalSat":plan["totalSat"],"sourceCount":plan["sources"].as_array().map_or(0,Vec::len)}))}).collect::<Result<Vec<_>,String>>()?;
    Ok(json!({"total":p.total,"plans":plans}))
}
pub fn consolidate(r: &Value) -> Reply {
    confirmed(r)?;
    let plan = plan(r)?;
    let source = id(&r["sourceId"], "Source wallet")?;
    let quote = plan["sources"]
        .as_array()
        .and_then(|rows| rows.iter().find(|q| q["sourceId"] == source))
        .ok_or("This source does not belong to the sweep.")?;
    let current = ledger::view(&plan)?;
    if !current["sources"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|s| s["sourceId"] == source && s["status"] == "ready")
    {
        return Ok(current);
    }
    if plan["expiresAt"].as_u64().unwrap_or(0) <= host::now() {
        return Err("This sweep expired. Review balances in a new sweep.".into());
    }
    if current["payoutCount"] != 0 {
        return Err("This sweep already has an external payment prepared.".into());
    }
    let amount = amount(&quote["amountSat"], "Amount")?;
    let leave = integer(&quote["leaveSat"])?;
    let mut attempt = ledger::start(&plan, &format!("source:{source}"))?;
    let b = balance(source)?;
    let outcome = if b["canSendPayments"] != true
        || integer(&b["balanceMsat"])? < (amount + leave) * 1000
    {
        json!({"status":"failed","error":"The balance or wallet permissions changed. No transfer was started."})
    } else {
        pay(
            source,
            s(&quote["invoice"]),
            amount,
            format!("Wallet Sweep to {}", s(&plan["destinationName"])),
            vec![
                ("sweep_id".into(), s(&plan["id"]).into()),
                ("phase".into(), "internal".into()),
                ("quote_id".into(), s(&quote["id"]).into()),
            ],
        )
    };
    record(&mut attempt, outcome);
    ledger::view(&plan)
}
pub fn prepare_payout(r: &Value) -> Reply {
    let plan = plan(r)?;
    let addr = s(&plan["address"]);
    if addr.is_empty() {
        return Err("This sweep has no external destination.".into());
    }
    let current = ledger::view(&plan)?;
    if !complete(&current) {
        return Err("Finish consolidation and resolve uncertain outcomes before preparing an external payment.".into());
    }
    let moved = amount(&current["movedSat"], "Consolidated amount")?;
    if moved == 0 {
        return Err("No confirmed funds were consolidated.".into());
    }
    if current["payoutCount"] == 1 {
        return Ok(current);
    }
    let extra = optional_amount(&r["extraReserveSat"], "Additional fee reserve")?;
    let dest = s(&plan["destinationId"]);
    let b = balance(dest)?;
    if b["canSendPayments"] != true || integer(&b["withdrawableMsat"])? <= 0 {
        return Err("The destination wallet cannot send this payment.".into());
    }
    let balance = integer(&b["balanceMsat"])?;
    let fee = (integer(&b["feeReserveMsat"])? + 999) / 1000 + extra;
    let sat = amount(&json!(moved.min(balance / 1000) - fee), "Payment amount")?;
    if sat == 0 {
        return Err("The consolidated funds cannot cover the fee reserve. Funds remain in the destination wallet.".into());
    }
    let limits = resolve(addr);
    if !((limits.min_sendable_msat)..=limits.max_sendable_msat).contains(&((sat * 1000) as u64)) {
        return Err("The amount is outside the Lightning Address payment limits. Funds remain in the destination wallet.".into());
    }
    let invoice = wit::pay_lnurl(&wit::LnurlRequest {
        wallet_id: dest.into(),
        lnurl: addr.into(),
        amount: sat as f64,
        currency: "sat".into(),
        comment: None,
        description: "Wallet Sweep external payment".into(),
        max_sat: Some(sat as u64),
        extra: vec![],
        fetch_only: true,
    });
    let invoice = invoice
        .payment_request
        .filter(|s| invoice.ok && !s.is_empty())
        .ok_or("Could not obtain a payment invoice. Funds remain in the destination wallet.")?;
    let ticket = json!({"id":host::id("payout_"),"planId":plan["id"],"createdAt":host::now(),"address":addr,"amountSat":sat,"feeReserveSat":fee,"extraReserveSat":extra,"destinationBalanceMsat":balance,"movedSat":moved,"invoice":invoice,"expiresAt":host::now()+300});
    ledger::save("payouts", &ticket, json!({"plan_id":plan["id"]}))?;
    ledger::view(&plan)
}
pub fn send_payout(r: &Value) -> Reply {
    confirmed(r)?;
    let plan = plan(r)?;
    if address(&r["address"])? != s(&plan["address"]) {
        return Err("Re-enter the Lightning Address exactly as shown.".into());
    }
    let current = ledger::view(&plan)?;
    if !complete(&current) {
        return Err("Consolidation is incomplete or has an uncertain outcome.".into());
    }
    if current["partial"] == true && r["confirmPartial"] != true {
        return Err("Acknowledge the failed source wallets before sending.".into());
    }
    let tickets = ledger::payouts(&plan)?;
    let ticket=tickets.first().ok_or("There must be exactly one prepared external payment. Keep funds in the wallet and review its history.")?;
    if id(&r["payoutId"], "Payment")? != s(&ticket["id"]) {
        return Err("This payment does not belong to the sweep.".into());
    }
    if current["payout"]["status"] != "ready" {
        return Ok(current);
    }
    if ticket["expiresAt"].as_u64().unwrap_or(0) <= host::now() {
        return Err("The prepared payment expired. Funds remain in the wallet; use its payment screen to send them.".into());
    }
    let dest = s(&plan["destinationId"]);
    let b = balance(dest)?;
    let amt = amount(&ticket["amountSat"], "Amount")?;
    if b["canSendPayments"] != true
        || integer(&b["balanceMsat"])? < (amt + integer(&ticket["feeReserveSat"])?) * 1000
    {
        return Err(
            "The destination balance or permissions changed. Funds remain in the wallet.".into(),
        );
    }
    let mut attempt = ledger::start(&plan, &format!("payout:{}", s(&ticket["id"])))?;
    let outcome = pay(
        dest,
        s(&ticket["invoice"]),
        amt,
        format!("Wallet Sweep to {}", s(&ticket["address"])),
        vec![
            ("sweep_id".into(), s(&plan["id"]).into()),
            ("phase".into(), "external".into()),
            ("lightning_address".into(), s(&ticket["address"]).into()),
        ],
    );
    record(&mut attempt, outcome);
    ledger::view(&plan)
}
fn confirmed(r: &Value) -> Result<(), String> {
    if r["confirm"] != true {
        return Err("Explicit confirmation is required.".into());
    }
    Ok(())
}
fn plan(r: &Value) -> Reply {
    ledger::load("plans", id(&r["planId"], "Sweep")?)
}
fn complete(v: &Value) -> bool {
    v["sources"].as_array().is_some_and(|rows| {
        rows.iter()
            .all(|r| matches!(s(&r["status"]), "success" | "skipped" | "failed"))
    })
}
fn optional_amount(v: &Value, name: &str) -> Result<i64, String> {
    if v.is_null() {
        Ok(0)
    } else {
        amount(v, name)
    }
}
fn integer(v: &Value) -> Result<i64, String> {
    v.as_i64()
        .filter(|n| n.unsigned_abs() <= MAX_SAFE as u64)
        .ok_or_else(|| "Amount exceeds supported precision.".into())
}
fn balance(id: &str) -> Reply {
    let b = wit::wallet_balance(&wit::WalletRequest {
        wallet_id: id.into(),
    });
    if [
        b.balance_msat,
        b.balance_sat,
        b.withdrawable_msat,
        b.withdrawable_sat,
        b.fee_reserve_msat,
        b.fee_reserve_sat,
    ]
    .iter()
    .any(|n| n.unsigned_abs() > MAX_SAFE as u64)
    {
        return Err("Wallet balance exceeds supported precision.".into());
    }
    let mut value = json!({"walletId":b.wallet_id,"name":b.name,"balanceMsat":b.balance_msat,"balanceSat":b.balance_sat,"withdrawableMsat":b.withdrawable_msat,"withdrawableSat":b.withdrawable_sat,"feeReserveMsat":b.fee_reserve_msat,"feeReserveSat":b.fee_reserve_sat,"canSendPayments":b.can_send_payments});
    if let Some(c) = b.currency {
        value["currency"] = json!(c);
    }
    Ok(value)
}
fn resolve(addr: &str) -> utils_lnurl::ResolveResponse {
    utils_lnurl::resolve(&utils_lnurl::ResolveRequest { lnurl: addr.into() })
}
// Persist intent before invoking the host. If the final write fails, the saved uncertain
// receipt prevents a second debit while the owner reconciles the payment.
fn record(attempt: &mut Value, outcome: Value) {
    if let (Some(row), Value::Object(fields)) = (attempt.as_object_mut(), outcome) {
        row.extend(fields);
    }
    let _ = ledger::finish(attempt);
}
fn pay(
    wallet: &str,
    invoice: &str,
    amount: i64,
    description: String,
    extra: Vec<(String, String)>,
) -> Value {
    let p = wit::pay_invoice(&wit::PayRequest {
        wallet_id: wallet.into(),
        payment_request: invoice.into(),
        max_sat: Some(amount as u64),
        description,
        extra,
    });
    let err = p.error.as_deref().unwrap_or("").to_lowercase();
    let (status, error) = if p.ok
        && p.success
        && !p.pending
        && p.amount_msat == (amount * 1000) as u64
    {
        ("success", None)
    } else if p.ok
        || ["already", "pending", "timeout", "timed out"]
            .iter()
            .any(|s| err.contains(s))
    {
        ("uncertain",Some("Settlement is not confirmed. Review the wallet payment history before taking further action."))
    } else if err.contains("insufficient") || err.contains("reserve") {
        (
            "failed",
            Some("Insufficient balance for the amount and fees. Funds remain in the wallet."),
        )
    } else if err.contains("expired") {
        (
            "failed",
            Some("The invoice expired. Funds remain in the wallet."),
        )
    } else {
        (
            "failed",
            Some("Payment failed. Review the wallet payment history for details."),
        )
    };
    json!({"paymentHash":p.payment_hash,"checkingId":p.checking_id,"amountMsat":p.amount_msat,"feeMsat":p.fee_msat,"status":status,"error":error})
}
