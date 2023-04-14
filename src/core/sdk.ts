import { MainApi } from './api/main-api';
import {
  CreateTransactionRequest,
  CreateWalletAuthorizationRequest,
} from './types';
import { WalletAuthorizationAction } from './actions/WalletAuthorizationAction';
import { TransactionAction } from './actions/TransactionAction';

export class PolyflowSDK {
  public api: MainApi;

  constructor(
    apiKey: string,
    projectId: string,
    baseApiUrl: string,
    identityApiUrl: string
  ) {
    this.api = new MainApi(baseApiUrl, identityApiUrl, apiKey, projectId);
  }

  async authorizeWallet(
    options: CreateWalletAuthorizationRequest
  ): Promise<WalletAuthorizationAction> {
    const payloadResponse = await this.api.getPayload();
    const generatedAction = await this.api.createWalletAuthorizationRequest({
      ...options,
      message_to_sign: payloadResponse.payload,
    });
    return new WalletAuthorizationAction(generatedAction, this);
  }

  async executeTransaction(
    options: CreateTransactionRequest
  ): Promise<TransactionAction> {
    const generatedAction = await this.api.createTransactionRequest(options);
    return new TransactionAction(generatedAction, this);
  }
}
