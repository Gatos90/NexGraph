package com.example.service;

import com.example.model.User;
import com.example.model.Notification;

public class NotificationService {
    private EmailSender emailSender;
    private TemplateEngine templateEngine;

    public void notifyUserCreated(User user) {
        String body = templateEngine.render("user-created", user);
        emailSender.send(user.getEmail(), "Welcome!", body);
    }

    public void notifyPasswordReset(User user, String token) {
        String body = templateEngine.render("password-reset", token);
        emailSender.send(user.getEmail(), "Password Reset", body);
    }

    public Notification createNotification(String message, String type) {
        return new Notification(message, type);
    }
}
