//! The computer's daily copies of the whole database.
//!
//! Sync mirrors: a deletion or a mistake on the phone reaches the computer
//! within minutes. These snapshots are what lets you go back past one: one a
//! day for the last two weeks, then one a week for about three months. Each
//! is a complete, consistent database (`VACUUM INTO`), named by its day.

use sqlx::SqlitePool;
use std::path::{Path, PathBuf};

/// Days kept one per day.
pub const DAILY: i64 = 14;
/// Beyond those, one per week back to this many days.
pub const WEEKLY_UNTIL: i64 = 91;

const PREFIX: &str = "tally-";
const SUFFIX: &str = ".db";

/// Days since 1970-01-01 of a "YYYY-MM-DD" date.
pub fn day_number(date: &str) -> Option<i64> {
    let mut p = date.split('-');
    let (y, m, d): (i64, i64, i64) = (p.next()?.parse().ok()?, p.next()?.parse().ok()?, p.next()?.parse().ok()?);
    if p.next().is_some() || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    // Days-from-civil (Howard Hinnant).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

// Spec: tandem.SYN-18
/// Which of `dates` to keep, given today: the last [`DAILY`] days, then the
/// newest of each week (Monday to Sunday) back to [`WEEKLY_UNTIL`] days.
pub fn keep(dates: &[String], today: &str) -> Vec<String> {
    let Some(t) = day_number(today) else { return dates.to_vec() };
    let mut by_week: std::collections::BTreeMap<i64, (i64, &String)> = Default::default();
    let mut out = Vec::new();
    for d in dates {
        let Some(n) = day_number(d) else { continue };
        let age = t - n;
        if (0..DAILY).contains(&age) {
            out.push(d.clone());
        } else if age >= DAILY && age < WEEKLY_UNTIL {
            // 1970-01-01 was a Thursday; +3 makes weeks start on Monday.
            let week = (n + 3).div_euclid(7);
            let e = by_week.entry(week).or_insert((n, d));
            if n > e.0 {
                *e = (n, d);
            }
        }
    }
    out.extend(by_week.into_values().map(|(_, d)| d.clone()));
    out.sort();
    out
}

fn date_of(name: &str) -> Option<String> {
    let d = name.strip_prefix(PREFIX)?.strip_suffix(SUFFIX)?;
    day_number(d).map(|_| d.to_string())
}

/// Takes today's snapshot into `dir` if there isn't one yet, then removes
/// the ones no longer kept. Returns the path written, if any.
pub async fn run(pool: &SqlitePool, dir: &Path, today: &str) -> Result<Option<PathBuf>, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let target = dir.join(format!("{PREFIX}{today}{SUFFIX}"));
    let mut written = None;
    if !target.exists() {
        let partial = dir.join(format!("{PREFIX}{today}.partial"));
        let _ = std::fs::remove_file(&partial);
        let path = partial.to_string_lossy().replace('\'', "''");
        sqlx::query(&format!("VACUUM INTO '{path}'")).execute(pool).await.map_err(|e| e.to_string())?;
        // Marked as a copy, so putting it back in place is noticed (instance.rs).
        super::instance::mark_copy(&partial).await?;
        std::fs::rename(&partial, &target).map_err(|e| e.to_string())?;
        written = Some(target);
    }
    let dates: Vec<String> = std::fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok()?.file_name().to_str().and_then(date_of))
        .collect();
    let kept = keep(&dates, today);
    for d in dates.iter().filter(|d| !kept.contains(d)) {
        let _ = std::fs::remove_file(dir.join(format!("{PREFIX}{d}{SUFFIX}")));
    }
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(n: i64) -> String {
        crate::sync::civil_date(n)
    }

    #[test]
    fn day_numbers_are_right() {
        assert_eq!(day_number("1970-01-01"), Some(0));
        assert_eq!(day_number("2000-03-01"), Some(11_017));
        assert_eq!(day_number("2026-11-16"), Some(20_773));
        assert_eq!(day_number("2026-13-01"), None);
        assert_eq!(day_number("nope"), None);
        for n in [0, 59, 60, 11_016, 20_773, 30_000] {
            assert_eq!(day_number(&date(n)), Some(n));
        }
    }

    // Spec: tandem.SYN-18
    #[test]
    fn a_year_of_daily_snapshots_thins_out_as_promised() {
        let today = day_number("2026-11-16").unwrap();
        let all: Vec<String> = (0..365).map(|age| date(today - age)).collect();
        let kept = keep(&all, &date(today));
        // Every one of the last 14 days…
        for age in 0..DAILY {
            assert!(kept.contains(&date(today - age)), "day -{age}");
        }
        // …then one per week (Monday to Sunday), the newest of it within the
        // weekly range, to ~3 months.
        let older: Vec<i64> = kept.iter().map(|d| day_number(d).unwrap()).filter(|n| today - n >= DAILY).collect();
        let weeks: std::collections::BTreeSet<i64> = older.iter().map(|n| (n + 3).div_euclid(7)).collect();
        assert_eq!(weeks.len(), older.len(), "one per week: {older:?}");
        assert!((11..=13).contains(&older.len()), "{older:?}");
        for n in &older {
            let week_end = (n + 3).div_euclid(7) * 7 - 3 + 6;
            assert!(*n == week_end || today - week_end < DAILY, "{} isn't its week's newest", date(*n));
        }
        let older: Vec<i64> = older.iter().map(|n| today - n).collect();
        // …and nothing older.
        assert!(older.iter().all(|a| *a < WEEKLY_UNTIL));
    }

    #[test]
    fn gaps_keep_what_there_is() {
        // Computer off for a while: the newest one of each week is kept anyway.
        let kept = keep(&["2026-10-01".into(), "2026-10-02".into(), "2026-11-16".into()], "2026-11-16");
        assert_eq!(kept, vec!["2026-10-02".to_string(), "2026-11-16".to_string()]);
    }

    #[tokio::test]
    async fn takes_one_a_day_and_prunes() {
        let scratch = crate::photos::tests::Scratch::new();
        let pool = crate::photos::tests::migrated_db(&scratch).await;
        sqlx::query("INSERT INTO food_entries (id, eaten_at, title, nutrients) VALUES ('m', 'now', 'Oats', '{}')")
            .execute(&pool)
            .await
            .unwrap();
        let dir = scratch.0.join("snapshots");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("tally-2025-01-01.db"), b"old").unwrap();
        std::fs::write(dir.join("notes.txt"), b"not ours").unwrap();

        let written = run(&pool, &dir, "2026-11-16").await.unwrap().unwrap();
        assert!(run(&pool, &dir, "2026-11-16").await.unwrap().is_none(), "one a day");
        assert!(!dir.join("tally-2025-01-01.db").exists());
        assert!(dir.join("notes.txt").exists());

        // The snapshot is a whole database.
        let snap = sqlx::sqlite::SqlitePoolOptions::new()
            .connect_with(sqlx::sqlite::SqliteConnectOptions::new().filename(&written))
            .await
            .unwrap();
        let t: String = sqlx::query_scalar("SELECT title FROM food_entries").fetch_one(&snap).await.unwrap();
        assert_eq!(t, "Oats");
    }
}
