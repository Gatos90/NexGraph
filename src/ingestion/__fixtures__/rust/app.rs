use crate::services::{AuthService, DatabasePool, MailService};

pub struct AppState {
    pub auth: AuthService,
    pub db: DatabasePool,
    pub mailer: MailService,
}

impl AppState {
    pub fn handle_login(&self, credentials: &Credentials) -> Result<TokenResponse, AppError> {
        let claims = self.auth.verify(&credentials.token)?;
        let new_token = self.auth.create_token(claims.user_id);
        Ok(TokenResponse { token: new_token })
    }

    pub fn handle_register(&self, input: &RegisterInput) -> Result<UserResponse, AppError> {
        self.db.execute(
            "INSERT INTO users (name, email) VALUES ($1, $2)",
            &[&input.name, &input.email],
        )?;

        self.mailer.send_welcome(&input.email)?;

        let rows = self.db.query(
            "SELECT * FROM users WHERE email = $1",
            &[&input.email],
        )?;

        Ok(UserResponse::from_row(&rows[0]))
    }

    pub fn handle_logout(&self, token: &str) -> Result<(), AppError> {
        self.auth.revoke_token(token)?;
        Ok(())
    }

    pub fn handle_reset_password(&self, email: &str) -> Result<(), AppError> {
        let rows = self.db.query(
            "SELECT * FROM users WHERE email = $1",
            &[email],
        )?;

        if !rows.is_empty() {
            let token = self.auth.create_token(rows[0].get("id"));
            self.mailer.send_reset(email, &token)?;
        }

        Ok(())
    }
}
