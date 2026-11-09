import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

/**
 * AUTHENTICATION EXTENSION POINT — deliberately a no-op (the challenge makes auth optional).
 * See ARCHITECTURE.md §Authentication for the intended design: an OIDC Identity Provider
 * (Keycloak/Zitadel) validated here through `ProviderIdentityPort`, with the token's
 * `provider_id` claim required to match `providerId` in submitted transactions.
 */
export const IS_PUBLIC = 'isPublic';
/** Health/metrics stay open even once a real guard is plugged in. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export interface ProviderIdentity {
  providerId: string;
}

/** Port a real IdP integration would implement (token verification → provider identity). */
export interface ProviderIdentityPort {
  authenticate(authorizationHeader: string | undefined): Promise<ProviderIdentity>;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;
    // No-op: every request is allowed. Replace with `ProviderIdentityPort` based verification.
    return true;
  }
}
