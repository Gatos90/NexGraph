import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { AuthService } from '../services/auth.service';

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const apiBase = auth.apiBase();
  const apiKey = auth.apiKey();

  if (apiKey && req.url.startsWith(apiBase)) {
    const cloned = req.clone({
      setHeaders: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });
    return next(cloned);
  }
  return next(req);
};
