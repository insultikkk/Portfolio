use crate::model::*;
use anyhow::Result;
use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;

pub struct Store {
    db: Connection,
}
impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let db = Connection::open(path)?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS lyrics (track_key TEXT PRIMARY KEY, document TEXT NOT NULL, updated_at REAL NOT NULL);")?;
        Ok(Self { db })
    }
    pub fn get<T: serde::de::DeserializeOwned>(&self, key: &str) -> Result<Option<T>> {
        let value: Option<String> = self
            .db
            .query_row("SELECT value FROM settings WHERE key=?1", [key], |r| {
                r.get(0)
            })
            .optional()?;
        value
            .map(|v| serde_json::from_str(&v).map_err(Into::into))
            .transpose()
    }
    pub fn set<T: serde::Serialize>(&self, key: &str, value: &T) -> Result<()> {
        self.db.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,serde_json::to_string(value)?])?;
        Ok(())
    }
    pub fn token(&self) -> Result<String> {
        if let Some(t) = self.get::<String>("pairing_token")? {
            return Ok(t);
        }
        self.rotate_token()
    }
    pub fn rotate_token(&self) -> Result<String> {
        let mut bytes = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        let token = hex::encode(bytes);
        self.set("pairing_token", &token)?;
        self.set("extension_origins", &Vec::<String>::new())?;
        Ok(token)
    }
    pub fn lyrics(&self, key: &str) -> Result<Option<LyricsDocument>> {
        let raw: Option<String> = self
            .db
            .query_row(
                "SELECT document FROM lyrics WHERE track_key=?1",
                [key],
                |r| r.get(0),
            )
            .optional()?;
        raw.map(|s| serde_json::from_str(&s).map_err(Into::into))
            .transpose()
    }
    pub fn save_lyrics(&self, doc: &LyricsDocument) -> Result<()> {
        self.db.execute("INSERT INTO lyrics VALUES(?1,?2,?3) ON CONFLICT(track_key) DO UPDATE SET document=excluded.document,updated_at=excluded.updated_at",params![doc.track_key,serde_json::to_string(doc)?,now_ms()])?;
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn persistence_and_token_rotation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db.sqlite");
        let s = Store::open(&path).unwrap();
        let token = s.token().unwrap();
        s.set("settings", &Settings::default()).unwrap();
        drop(s);
        let s = Store::open(&path).unwrap();
        assert_eq!(s.token().unwrap(), token);
        assert_eq!(s.get::<Settings>("settings").unwrap().unwrap().width, 340.0);
        assert_ne!(s.rotate_token().unwrap(), token);
    }
}
