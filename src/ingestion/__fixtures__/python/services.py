from typing import Optional, List


class UserRepository:
    def find_by_id(self, user_id: int) -> Optional["User"]:
        return db.query(User).filter(User.id == user_id).first()

    def find_by_email(self, email: str) -> Optional["User"]:
        return db.query(User).filter(User.email == email).first()

    def save(self, user: "User") -> "User":
        db.add(user)
        db.commit()
        return user


class EmailService:
    def send_welcome(self, email: str, name: str) -> bool:
        template = self.render_template("welcome", name=name)
        return self.send(email, "Welcome!", template)

    def send_reset_password(self, email: str, token: str) -> bool:
        template = self.render_template("reset", token=token)
        return self.send(email, "Reset your password", template)

    def send(self, to: str, subject: str, body: str) -> bool:
        pass

    def render_template(self, name: str, **kwargs) -> str:
        pass


class PaymentGateway:
    def charge(self, amount: float, currency: str, token: str) -> "PaymentResult":
        pass

    def refund(self, transaction_id: str) -> "RefundResult":
        pass

    def get_balance(self) -> float:
        pass
