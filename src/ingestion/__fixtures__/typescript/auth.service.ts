import { HttpClient } from "@angular/common/http";
import { Injectable } from "@angular/core";
import { TokenStore } from "./token-store";

@Injectable({ providedIn: "root" })
export class AuthService {
  constructor(
    private http: HttpClient,
    private tokenStore: TokenStore,
  ) {}

  login(username: string, password: string): Promise<LoginResponse> {
    return this.http.post("/api/auth/login", { username, password });
  }

  logout(): void {
    this.tokenStore.clear();
  }

  refreshToken(): Promise<string> {
    const current = this.tokenStore.getRefreshToken();
    return this.http.post("/api/auth/refresh", { token: current });
  }

  isAuthenticated(): boolean {
    return this.tokenStore.hasValidToken();
  }
}
