import { Component, OnInit, inject } from "@angular/core";
import { AuthService } from "./auth.service";
import { UserService } from "./user.service";
import { NotificationService } from "./notification.service";

@Component({
  selector: "app-dashboard",
  templateUrl: "./dashboard.component.html",
})
export class DashboardComponent implements OnInit {
  constructor(
    private authService: AuthService,
    private readonly userService: UserService,
  ) {}

  private notificationService = inject(NotificationService);
  protected analyticsTracker: AnalyticsTracker;

  currentUser: UserProfile | null = null;

  ngOnInit(): void {
    if (!this.authService.isAuthenticated()) {
      this.authService.refreshToken();
      return;
    }

    this.userService.getProfile("me").then((user) => {
      this.currentUser = user;
      this.notificationService.showWelcome(user.name);
    });
  }

  onLogout(): void {
    this.authService.logout();
    this.notificationService.showInfo("Logged out successfully");
  }

  onSearch(query: string): void {
    this.userService.searchUsers(query).then((results) => {
      this.analyticsTracker.trackSearch(query, results.length);
    });
  }
}
