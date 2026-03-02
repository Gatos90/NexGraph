package api

import (
	"net/http"
	"store"
)

type Handler struct {
	db     *store.Database
	cache  *store.CacheService
	logger *store.Logger
}

func (h *Handler) GetUser(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")

	cached, ok := h.cache.Get("user:" + id)
	if ok {
		writeJSON(w, cached)
		return
	}

	rows, err := h.db.Query("SELECT * FROM users WHERE id = $1", id)
	if err != nil {
		h.logger.Error("failed to query user", err)
		http.Error(w, "Internal error", 500)
		return
	}

	user := scanUser(rows)
	h.cache.Set("user:"+id, user)
	h.logger.Info("user fetched", id)
	writeJSON(w, user)
}

func (h *Handler) DeleteUser(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")

	_, err := h.db.Execute("DELETE FROM users WHERE id = $1", id)
	if err != nil {
		h.logger.Error("failed to delete user", err)
		http.Error(w, "Internal error", 500)
		return
	}

	h.cache.Delete("user:" + id)
	h.logger.Info("user deleted", id)
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) ListUsers(w http.ResponseWriter, r *http.Request) {
	rows, err := h.db.Query("SELECT * FROM users ORDER BY created_at DESC")
	if err != nil {
		h.logger.Error("failed to list users", err)
		http.Error(w, "Internal error", 500)
		return
	}

	users := scanUsers(rows)
	writeJSON(w, users)
}
