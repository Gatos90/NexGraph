package com.example.service;

import com.example.repository.UserRepository;
import com.example.model.User;
import java.util.Optional;
import java.util.List;

public class UserService {
    private UserRepository userRepository;

    public Optional<User> findById(Long id) {
        return userRepository.findById(id);
    }

    public User save(User user) {
        return userRepository.save(user);
    }

    public void deleteById(Long id) {
        userRepository.deleteById(id);
    }

    public List<User> findAll() {
        return userRepository.findAll();
    }
}
