# Polaris

Run Polaris actions and show live Polaris state on Companion buttons.

## Setting up

1. Type the address you open Polaris at, such as `https://polaris.example.com`, and save.
2. The connection's status shows a code and a page. Open that page in a browser, sign in to Polaris and approve the code.
3. The actions, feedbacks, variables and presets your account may use appear on their own.

The **polaris** presets start with a button showing the Polaris mark, to head a page of your Polaris buttons.

To stop using it, run the **sign out** action, or disconnect it from **Downloads** in Polaris.

## Timers

The **Timer** action and feedbacks keep a countdown on this machine, or, with **Kept** set to **In Polaris**, work one of your Calendar timers: one you already have, a new one (made, with the name you give it, on the first press) or the focus cycle.

- A press starts or pauses, resets, adds a minute, or skips the focus cycle's phase.
- **Timer: time left** colours the button (green running, amber paused, red done) and shows the name and time left. **Timer: is running**, **is paused** and **is done** light it on that state.
- A Polaris timer shows changes made in Calendar, or on another device, within a second.

## Variables

- `$(polaris:connection)`: where the connection stands
- `$(polaris:account)`: who it is signed in as
- `$(polaris:sign_in_code)` and `$(polaris:sign_in_url)`: the code to approve, while signing in
- One per live Polaris state that needs nothing picked, such as `$(polaris:chat_unread)` or `$(polaris:polaris_notifications)`
- Three per timer in use, named after it: `$(polaris:timer_tea_remaining)`, `$(polaris:timer_tea_state)` (`running`, `paused`, `done`, `idle` or `unavailable`) and `$(polaris:timer_tea_name)`. The focus cycle is `timer_focus`; a timer kept on this machine starts with `local_timer_`.
