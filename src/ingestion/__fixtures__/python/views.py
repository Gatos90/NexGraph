from typing import Optional
from services import UserRepository, EmailService, PaymentGateway


class UserView:
    def __init__(self, user_repo: UserRepository, email_service: EmailService):
        self.user_repo = user_repo
        self.email_service = email_service

    def get_user(self, request):
        user = self.user_repo.find_by_id(request.user_id)
        if not user:
            raise NotFoundError("User not found")
        return user

    def create_user(self, request):
        user = User(name=request.name, email=request.email)
        saved = self.user_repo.save(user)
        self.email_service.send_welcome(saved.email, saved.name)
        return saved

    def reset_password(self, request):
        user = self.user_repo.find_by_email(request.email)
        if user:
            token = generate_token()
            self.email_service.send_reset_password(user.email, token)


class OrderView:
    payment: PaymentGateway
    user_repo: UserRepository

    def process_order(self, request):
        user = self.user_repo.find_by_id(request.user_id)
        result = self.payment.charge(
            request.total, request.currency, request.payment_token
        )
        return {"order_id": result.transaction_id, "user": user.name}

    def refund_order(self, request):
        result = self.payment.refund(request.transaction_id)
        return {"refund_id": result.id}
