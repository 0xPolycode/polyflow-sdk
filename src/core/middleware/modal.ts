import { SDKError } from '../error';
import { WalletAuthorizationAction } from '../actions/WalletAuthorizationAction';
import { poll } from '../helpers/util';
import { RequestStatus } from '../types';
import { PolyflowSDK } from '../sdk';
import { TransactionAction } from '../actions/TransactionAction';

export type SupportedActionType = WalletAuthorizationAction | TransactionAction;

export async function present(
  action: SupportedActionType,
  sdk: PolyflowSDK
): Promise<SupportedActionType> {
  const actionUuid = extractUuidFromUrl(action.actionUrl);
  console.log(actionUuid);
  if (!actionUuid) {
    throw new SDKError(
      `Invalid action url. No action uuid found in the ${action.actionUrl}`
    );
  }

  let actionDataFetcher: () => Promise<SupportedActionType>;
  if (action.actionUrl.includes('/request-authorization')) {
    actionDataFetcher = async () => {
      const response = await sdk.api.fetchWalletAuthorizationRequestById(
        actionUuid
      );
      return new WalletAuthorizationAction(response, sdk);
    };
  } else if (action.actionUrl.includes('/request-arbitrary-call')) {
    actionDataFetcher = async () => {
      const response = await sdk.api.fetchTransactionRequestById(actionUuid);
      return new TransactionAction(response, sdk);
    };
  } else {
    throw new SDKError(
      `Could not parse action url. Given url ${action.actionUrl} is not a request-deploy, request-function-call, request-send or request-authorization action.`
    );
  }

  const css = document.createElement('style');
  css.innerHTML = `
        .polyflow-modal-container {
            position: fixed !important;
            top: 0 !important;
            left: 0 !important;
            background: rgba(0,0,0,0.6) !important;
            z-index: 999999 !important;
            width: 100% !important;
            height: 100% !important;
            display: block !important;
            padding: 32px 16px !important;
            -ms-overflow-style: none !important;  /* Internet Explorer 10+ */
            scrollbar-width: none !important;  /* Firefox */
        }

        .polyflow-modal-container::-webkit-scrollbar { 
            display: none !important;  /* Safari and Chrome */
        }

        .polyflow-modal-frame {
            width: 100% !important;
            margin: auto !important;
            max-width: 500px !important;
            display: block !important;
            border: none !important;
            border-radius: 16px !important;
            height: 100% !important;
            max-height: 700px !important;
        }

        .polyflow-cancel-button {
          position: absolute !important;
          right: 24px !important;
          top: 10px !important;
          z-index: 1 !important;
          color: #f2f7ff !important;
          font-size: 2rem !important;
          background: transparent !important;
          border: none !important;
        }
    `;
  document.getElementsByTagName('head')[0].appendChild(css);

  const containerDiv = document.createElement('div');
  containerDiv.className = 'polyflow-modal-container';
  containerDiv.innerHTML = `<iframe class='polyflow-modal-frame' src="${
    action.actionUrl + '?sdk=true'
  }"/>`;
  const cancelButton = document.createElement('button');
  cancelButton.className = 'polyflow-cancel-button';
  cancelButton.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" stroke-width="1.5" stroke="currentColor" width="32px" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" d="M9.75 9.75l4.5 4.5m0-4.5l-4.5 4.5M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
    /svg>
  `;
  cancelButton.onclick = () => {
    containerDiv.remove();
    css.remove();
  };
  containerDiv.appendChild(cancelButton);
  document.body.appendChild(containerDiv);

  return awaitResult(containerDiv, css, actionDataFetcher);
}

function awaitResult(
  forModal: HTMLDivElement,
  withCss: HTMLStyleElement,
  actionDataFetcher: () => Promise<SupportedActionType>
): Promise<SupportedActionType> {
  return new Promise((resolve, reject) => {
    poll<SupportedActionType>(actionDataFetcher, (response) => {
      if ('authorizationRequest' in response) {
        return (
          response.status === RequestStatus.PENDING && forModal.isConnected
        );
      } else {
        return (
          !response.transactionRequest.arbitrary_call_tx.tx_hash &&
          forModal.isConnected
        );
      }
    })
      .then((result) => {
        forModal.remove();
        withCss.remove();
        resolve(result);
      })
      .catch((err) => {
        forModal.remove();
        withCss.remove();
        reject(err);
      });
  });
}

function extractUuidFromUrl(actionUrl: string): string | undefined {
  const matches = actionUrl.match(/([a-fA-F0-9\d-]+)\/action/);
  const UUID = matches?.at(1);
  return UUID;
}
