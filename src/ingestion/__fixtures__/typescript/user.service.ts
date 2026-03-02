import { Injectable } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import { CacheService } from "./cache.service";

@Injectable({ providedIn: "root" })
export class UserService {
  constructor(
    private http: HttpClient,
    private cache: CacheService,
  ) {}

  getProfile(userId: string): Promise<UserProfile> {
    const cached = this.cache.get(`user:${userId}`);
    if (cached) return Promise.resolve(cached);
    return this.http.get(`/api/users/${userId}`);
  }

  updateProfile(userId: string, data: Partial<UserProfile>): Promise<UserProfile> {
    this.cache.invalidate(`user:${userId}`);
    return this.http.put(`/api/users/${userId}`, data);
  }

  searchUsers(query: string): Promise<UserProfile[]> {
    return this.http.get(`/api/users/search?q=${query}`);
  }
}
