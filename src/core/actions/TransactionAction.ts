import { RequestStatus, TransactionRequest } from '../types';
import * as Modal from '../middleware/modal';
import { PolyflowSDK } from '../sdk';

export class TransactionAction {
  private readonly sdk: PolyflowSDK;
  public readonly transactionRequest: TransactionRequest;

  constructor(transactionRequest: TransactionRequest, sdk: PolyflowSDK) {
    this.transactionRequest = transactionRequest;
    this.sdk = sdk;
  }

  get actionUrl(): string {
    return this.transactionRequest.redirect_url;
  }

  get status(): RequestStatus {
    return this.transactionRequest.status;
  }

  get hash(): string | undefined {
    return this.transactionRequest.arbitrary_call_tx.tx_hash;
  }

  public async present(): Promise<TransactionAction> {
    return (await Modal.present(this, this.sdk)) as TransactionAction;
  }
}
