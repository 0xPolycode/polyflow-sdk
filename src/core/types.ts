export interface ScreenConfig {
  before_action_message?: string;
  after_action_message?: string;
}

export enum RequestStatus {
  SUCCESS = 'SUCCESS',
  PENDING = 'PENDING',
  FAILURE = 'FAILURE',
}

export interface EncodedFunctionParameter {
  type: string;
  value: string | string[] | boolean | EncodedFunctionParameter[];
}

export interface TxData {
  tx_hash?: string;
  from?: string;
  to: string;
  data?: string;
  value: string;
  block_confirmations?: number;
  timestamp?: Date;
}

export interface CreateTransactionRequest {
  contract_address: string;
  function_data: string;
  eth_amount: string;
  arbitrary_data?: Map<string, unknown>;
  screen_config?: ScreenConfig;
  caller_address?: string;
  redirect_url?: string;
}

export interface TransactionRequest {
  id: string;
  status: RequestStatus;
  deployed_contract_id?: string;
  contract_address: string;
  function_name?: string;
  function_params: EncodedFunctionParameter[];
  function_call_data: string;
  eth_amount: string;
  chain_id: number;
  redirect_url: string;
  project_id: string;
  created_at: string;
  arbitrary_data?: Map<string, unknown>;
  screen_config: ScreenConfig;
  caller_address?: string;
  arbitrary_call_tx: TxData;
  events?: any;
}

export interface CreateWalletAuthorizationRequest {
  wallet_address?: string;
  redirect_url?: string;
  arbitrary_data?: Map<string, unknown>;
  screen_config?: ScreenConfig;
  message_to_sign?: string;
  store_indefinitely?: boolean;
}

export interface WalletAuthorizationRequest {
  id: string;
  project_id: string;
  status: RequestStatus;
  redirect_url: string;
  wallet_address?: string;
  arbitrary_data?: Map<string, unknown>;
  screen_config?: ScreenConfig;
  message_to_sign: string;
  signed_message?: string;
  created_at: Date;
}

export interface JwtToken {
  access_token: string;
  expires_in: string;
  refresh_token: string;
  refresh_token_expires_in: string;
}

export interface GetJwtByMessageRequest {
  address: string;
  message_to_sign: string;
  signed_payload: string;
}

export interface GetPayloadRequest {
  address?: string;
}

export interface GetPayload {
  payload: string;
}
