import {
  CreateWalletAuthorizationRequest,
  WalletAuthorizationRequest,
  JwtToken,
  GetJwtByMessageRequest,
  GetPayload,
  GetPayloadRequest,
  CreateTransactionRequest,
  TransactionRequest,
} from '../types';
import { HttpClient } from './http-client';
import { SDKError } from '../error';

export class MainApi extends HttpClient {
  private static classInstance?: MainApi;

  constructor(
    baseURL: string,
    identityBaseURL: string,
    apiKey: string,
    projectId: string
  ) {
    super(baseURL, identityBaseURL, apiKey, projectId);
  }

  public static init(
    baseURL: string,
    identityBaseURL: string,
    apiKey: string,
    projectId: string
  ) {
    if (!this.classInstance) {
      this.classInstance = new MainApi(
        baseURL,
        identityBaseURL,
        apiKey,
        projectId
      );
    }
  }

  public static instance(): MainApi {
    if (this.classInstance === undefined) {
      throw new SDKError('API module not initialized.');
    }
    return this.classInstance;
  }

  public async createTransactionRequest(
    request: CreateTransactionRequest
  ): Promise<TransactionRequest> {
    const result = await this.protectedInstance.post<TransactionRequest>(
      'arbitrary-call',
      request
    );
    return result;
  }

  public async fetchTransactionRequestById(
    id: string
  ): Promise<TransactionRequest> {
    const result = await this.instance.get<TransactionRequest>(
      `arbitrary-call/${id}`
    );
    return result;
  }

  public async createWalletAuthorizationRequest(
    request: CreateWalletAuthorizationRequest
  ): Promise<WalletAuthorizationRequest> {
    const result =
      await this.protectedInstance.post<WalletAuthorizationRequest>(
        'wallet-authorization',
        request
      );
    return result;
  }

  public async fetchWalletAuthorizationRequestById(
    id: string
  ): Promise<WalletAuthorizationRequest> {
    const result = await this.instance.get<WalletAuthorizationRequest>(
      `wallet-authorization/${id}`
    );
    return result;
  }

  public async getJwtByMessage(
    request: GetJwtByMessageRequest
  ): Promise<JwtToken> {
    return this.identityServiceInstance.post<JwtToken>(
      'authorize/jwt/by-message',
      request
    );
  }

  public async getPayload(request?: GetPayloadRequest): Promise<GetPayload> {
    const wallet = request?.address;
    if (wallet) {
      return this.identityServiceInstance.post<GetPayload>('authorize', {
        address: wallet,
      });
    } else {
      return this.identityServiceInstance.post<GetPayload>(
        'authorize/by-message'
      );
    }
  }
}
