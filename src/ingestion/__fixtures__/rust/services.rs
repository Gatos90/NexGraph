use std::collections::HashMap;

pub struct AuthService {
    secret_key: String,
}

impl AuthService {
    pub fn verify(&self, token: &str) -> Result<Claims, AuthError> {
        jwt::decode(token, &self.secret_key)
    }

    pub fn create_token(&self, user_id: u64) -> String {
        jwt::encode(user_id, &self.secret_key)
    }

    pub fn revoke_token(&self, token: &str) -> Result<(), AuthError> {
        self.blacklist.insert(token.to_string());
        Ok(())
    }
}

pub struct DatabasePool {
    pool: Vec<Connection>,
}

impl DatabasePool {
    pub fn query(&self, sql: &str, params: &[&str]) -> Result<Vec<Row>, DbError> {
        let conn = self.pool.first().unwrap();
        conn.execute(sql, params)
    }

    pub fn execute(&self, sql: &str, params: &[&str]) -> Result<u64, DbError> {
        let conn = self.pool.first().unwrap();
        conn.execute_mut(sql, params)
    }
}

pub struct MailService {
    smtp_host: String,
}

impl MailService {
    pub fn send_welcome(&self, email: &str) -> Result<(), MailError> {
        let body = format!("Welcome to our platform!");
        self.send(email, "Welcome!", &body)
    }

    pub fn send_reset(&self, email: &str, token: &str) -> Result<(), MailError> {
        let body = format!("Reset link: /reset?token={}", token);
        self.send(email, "Password Reset", &body)
    }

    fn send(&self, to: &str, subject: &str, body: &str) -> Result<(), MailError> {
        Ok(())
    }
}
