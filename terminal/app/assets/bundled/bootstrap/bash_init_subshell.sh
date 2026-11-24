# command -p resolves the given command with the system default PATH, ensuring the shell
# can find them even if the user has a clobbered PATH value.
command -p stty raw
unset PROMPT_COMMAND
HISTCONTROL=ignorespace
HISTIGNORE=" *"
POLARIS_TERMINAL_IS_SUBSHELL=1
POLARIS_TERMINAL_SESSION_ID=@@POLARIS_TERMINAL_SESSION_ID@@
_hostname=$(command -pv hostname >/dev/null 2>&1 && command -p hostname 2>/dev/null || command -p uname -n)
_user=$(command -pv whoami >/dev/null 2>&1 && command -p whoami 2>/dev/null || echo $USER)
_msg=$(printf "{\"hook\": \"InitShell\", \"value\": {\"session_id\": $POLARIS_TERMINAL_SESSION_ID, \"shell\": \"bash\", \"user\": \"%s\", \"hostname\": \"%s\", \"is_subshell\": true}}" "$_user" "$_hostname" | command -p od -An -v -tx1 | command -p tr -d " \n")
if [[ "$OS" == Windows_NT ]]; then POLARIS_TERMINAL_IN_MSYS2=true; else POLARIS_TERMINAL_IN_MSYS2=false; fi
POLARIS_TERMINAL_USING_WINDOWS_CON_PTY=@@USING_CON_PTY_BOOLEAN@@
if [ "$POLARIS_TERMINAL_USING_WINDOWS_CON_PTY" = true ]; then printf '\e]9278;d;%s\x07' "$_msg"; else printf '\x1b\x50\x24\x64%s\x1b\x5c' "$_msg"; fi
unset _hostname _user _msg
