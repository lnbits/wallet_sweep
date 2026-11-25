use serde_json::Value;
pub const MAX_SAFE: i64 = 9_007_199_254_740_991;
pub fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
pub fn amount(v: &Value, name: &str) -> Result<i64, String> {
    let n = v
        .as_i64()
        .or_else(|| v.as_f64().filter(|n| n.fract() == 0.).map(|n| n as i64));
    n.filter(|n| (0..=MAX_SAFE / 1000).contains(n))
        .ok_or_else(|| format!("{name} must be a non-negative whole number of sats."))
}
pub fn id<'a>(v: &'a Value, name: &str) -> Result<&'a str, String> {
    let id = s(v);
    if id.is_empty()
        || id.len() > 256
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return Err(format!("{name} is invalid."));
    }
    Ok(id)
}
pub fn address(v: &Value) -> Result<String, String> {
    let value = v
        .as_str()
        .filter(|s| s.len() <= 254)
        .ok_or("Enter a valid Lightning Address.")?
        .trim();
    let error = "Enter a Lightning Address such as name@example.com.";
    let (local, domain) = value.split_once('@').ok_or(error)?;
    if local.is_empty()
        || !local
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._%+-".contains(&b))
        || !domain.contains('.')
        || !domain.split('.').all(|s| {
            !s.is_empty()
                && s.len() <= 63
                && !s.starts_with('-')
                && !s.ends_with('-')
                && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
    {
        return Err(error.into());
    }
    Ok(format!("{local}@{}", domain.to_ascii_lowercase()))
}
