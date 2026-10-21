# Polaris

Run Polaris actions and show live Polaris state on Companion buttons.

## Setting up

1. Type the address you open Polaris at, such as `https://polaris.example.com`, and save.
2. The connection's status shows a code and a page. Open that page in a browser, sign in to Polaris and approve the code.
3. The actions, feedbacks, variables and presets your account may use appear on their own.

To stop using it, run the **sign out** action, or disconnect it from **Downloads** in Polaris.

## Variables

- `$(polaris:connection)`: where the connection stands
- `$(polaris:account)`: who it is signed in as
- `$(polaris:sign_in_code)` and `$(polaris:sign_in_url)`: the code to approve, while signing in
- One per live Polaris state that needs nothing picked, such as `$(polaris:chat_unread)` or `$(polaris:polaris_notifications)`
