# Connecting payments to TillSawa

## Test the M-Pesa phone prompt

Use your own Daraja sandbox app. On the TillSawa main server or standalone Windows computer, create the private file described in [test installation](test-installation.md#optional-daraja-sandbox-setup). Use sandbox credentials, the assigned test shortcode, and a public HTTPS callback you control. Keep the credentials on the server and restart TillSawa. This update does not provide a public callback host.

In checkout, choose **M-Pesa > Use M-Pesa test phone prompt**, enter the sandbox test phone, and select **Send test prompt**. TillSawa queries Daraja for that exact checkout. It checks automatically up to five times, then offers a manual status check. A request acknowledgment or ambiguous status never marks a payment paid. If the result is uncertain, reconcile it in the provider portal before retrying. Sandbox payments move no real money.

Safaricom references: [Daraja portal](https://developer.safaricom.co.ke/) and [M-Pesa Express Query](https://developer.safaricom.co.ke/apis/mpesaexpressquery).

## Live M-Pesa and card

Live M-Pesa requires a production-enabled Daraja merchant setup or your chosen provider's production account and specifications. Confirm whether the shop uses PayBill or Buy Goods/Till before implementing live routing. Do not reuse sandbox settings for production.

For card, specify the acquiring bank/provider and physical terminal model. An in-person terminal integration and an online hosted card payment page are different workflows. For example, Pesapal publishes a [POS API access page](https://developer.pesapal.com/how-to-integrate/point-of-sale/api-reference) and separate [hosted checkout instructions](https://developer.pesapal.com/how-to-integrate/e-commerce/api-30-json/submitorderrequest). Use the selected provider's test account and supported interface. Until that connector is added, use the bank terminal separately and record its verified approval reference in TillSawa. Never enter card details into TillSawa.

## Pesapal terminal verification

TillSawa supports the documented Pesapal terminal verification API for card and M-Pesa in KES. Enable it for one shop per server. Ask Pesapal for terminal verification access and confirm your terminal can enter a merchant reference. Pesapal's [wireless terminal documentation](https://developer.pesapal.com/how-to-integrate/point-of-sale/wireless-connection) describes the API key and server IP requirement.

On standalone Windows or the main shared server, create a private **%LOCALAPPDATA%\KenyaPOS-Test\pesapal-terminal.env** file. On the cloud POS, place the same values in the server-side **.env.cloud** and recreate the app container. The hosting administrator can get the shop UUID from the organizations table or the authenticated bootstrap response. Never put the key on a shared till, in an installer or in chat.

```dotenv
PESAPAL_TERMINAL_API_KEY=your_terminal_verification_key
PESAPAL_ORGANIZATION_ID=the_tillsawa_shop_uuid
```

Restart TillSawa. Select **Card** or **M-Pesa**, then **Use Pesapal terminal** and **Prepare Pesapal payment**. Enter the displayed merchant reference and exact KES amount on the terminal. After the customer pays, enter the terminal confirmation code in TillSawa and select **Verify with Pesapal**. Complete the sale only after confirmation. This requests verification of a completed terminal payment; it does not send a charge or phone prompt. If the terminal cannot supply the merchant reference, use the existing manual process until a compatible terminal or connector is available.

Automatic wired terminal initiation requires separate [Sabi API access](https://developer.pesapal.com/how-to-integrate/point-of-sale/pos-wired-connection). This connector does not add direct bank APIs, Airtel Money, payment refunds, or hosted checkout.

### Send the M-Pesa prompt from the Pesapal terminal

For a Pesapal-only payment setup, prepare the M-Pesa sale in TillSawa first. On a compatible Pesapal terminal, use the sale amount and TillSawa merchant reference, choose **M-Pesa Xpress**, and enter the customer's phone number. Pesapal sends the prompt and the customer approves it on their own phone. After the terminal confirms payment, verify its confirmation code in TillSawa before completing the sale. Confirm with Pesapal that the terminal's M-Pesa Xpress flow carries the merchant reference into the verification response; TillSawa requires that match.

See [Pesapal's terminal prompt guide](https://www.pesapal.com/blog/how-to-send-m-pesa-prompt-on-pesapal-pos-terminal). A prompt button inside TillSawa itself is separate: confirm that Pesapal offers cashier-initiated M-Pesa prompts through the merchant's enabled API, and get the applicable integration documentation before building that button.
