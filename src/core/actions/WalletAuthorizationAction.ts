import { WalletAuthorizationRequest, RequestStatus } from '../types';
import { User } from '../identity/User';
import * as Modal from '../middleware/modal';
import { PolyflowSDK } from '../sdk';

export class WalletAuthorizationAction {
  private readonly sdk: PolyflowSDK;
  public readonly authorizationRequest: WalletAuthorizationRequest;

  constructor(
    authorizationRequest: WalletAuthorizationRequest,
    sdk: PolyflowSDK
  ) {
    this.authorizationRequest = authorizationRequest;
    this.sdk = sdk;
  }

  get actionUrl(): string {
    return this.authorizationRequest.redirect_url;
  }

  get status(): RequestStatus {
    return this.authorizationRequest.status;
  }

  get wallet(): string | undefined {
    return this.authorizationRequest.wallet_address;
  }

  public async present(): Promise<User | undefined> {
    const authAction = (await Modal.present(
      this,
      this.sdk
    )) as WalletAuthorizationAction;
    if (
      !authAction.authorizationRequest.signed_message ||
      !authAction.authorizationRequest.wallet_address ||
      authAction.authorizationRequest.status !== RequestStatus.SUCCESS
    ) {
      return undefined;
    }

    const jwt = await this.sdk.api.getJwtByMessage({
      message_to_sign: authAction.authorizationRequest.message_to_sign,
      signed_payload: authAction.authorizationRequest.signed_message!,
      address: authAction.authorizationRequest.wallet_address!,
    });

    return new User(authAction.wallet!, jwt);
  }
}
