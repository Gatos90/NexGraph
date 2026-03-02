package com.example.controller;

import com.example.service.UserService;
import com.example.service.NotificationService;
import com.example.model.User;
import java.util.List;
import java.util.Optional;

public class UserController {
    private UserService userService;
    private NotificationService notificationService;
    private AuditLogger auditLogger;

    public ResponseEntity<User> getUser(Long id) {
        Optional<User> user = userService.findById(id);
        if (user.isPresent()) {
            auditLogger.logAccess("user", id);
            return ResponseEntity.ok(user.get());
        }
        return ResponseEntity.notFound().build();
    }

    public ResponseEntity<User> createUser(UserRequest request) {
        User user = new User(request.getName(), request.getEmail());
        User saved = userService.save(user);
        notificationService.notifyUserCreated(saved);
        auditLogger.logCreate("user", saved.getId());
        return ResponseEntity.created(saved);
    }

    public ResponseEntity<Void> deleteUser(Long id) {
        userService.deleteById(id);
        auditLogger.logDelete("user", id);
        return ResponseEntity.noContent().build();
    }

    public ResponseEntity<List<User>> listUsers() {
        List<User> users = userService.findAll();
        return ResponseEntity.ok(users);
    }
}
