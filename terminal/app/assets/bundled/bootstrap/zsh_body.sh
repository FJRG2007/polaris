# Note that ROOK_SESSION_ID is expected to have been set when executing commands to
# emit the InitShell payload, which includes the session ID.
#
# Throughout, command -p is used to call external binaries. command -p resolves the
# given command using the system default $PATH, which ensures the shells can locate
# the corresponding binaries even if the user has a clobbered value of $PATH.
if [[ -z $ROOK_BOOTSTRAPPED ]]; then
  # Return PS2 to its original value.  We set this to an empty string in zsh.sh,
  # and want to reset it now that we've received the bootstrap script and started
  # to eval it.
  if (( ${+ORIGINAL_PS2} )); then
    PS2="$ORIGINAL_PS2"
  else
    unset PS2
  fi

  # Byte sequence used to signal the start of a DCS. ([0x1b, 0x50, 0x24] which
  # maps to <ESC>, P, $ in ASCII.)
  DCS_START="$(printf '\eP$')"

  # Appended to $DCS_START to signal that the following message is JSON-encoded.
  DCS_JSON_MARKER="d"

  # Byte sequence used to signal the end of a DCS (7-bit ST: ESC \).
  DCS_END="$(printf '\x1b\x5c')"

  # OSC used to mark the start of in-band command output.
  #
  # Printable characters received this OSC and OSC_END_GENERATOR_OUTPUT are parsed and handled as
  # output for an in-band command.
  OSC_START_GENERATOR_OUTPUT="$(printf '\e]9277;A\a')"

  # OSC used to mark the end of in-band command output.
  #
  # Printable characters received between OSC_START_GENERATOR_OUTPUT and this are parsed and
  # handled as output for an in-band command.
  OSC_END_GENERATOR_OUTPUT="$(printf '\e]9277;B\a')"

  OSC_START="$(printf '\e]9278;')"

  OSC_END="$(printf '\a')"

  OSC_PARAM_SEPARATOR=";"

  OSC_RESET_GRID="$(printf '\e]9279\a')"

  # Attempt to cd to the desired initial working directory, swallowing any
  # errors.  If this fails, the user will end up in their home directory.
  if [[ ! -z "$ROOK_INITIAL_WORKING_DIR" ]]; then
    cd "$ROOK_INITIAL_WORKING_DIR" >/dev/null 2>&1
    unset ROOK_INITIAL_WORKING_DIR
  fi

  # We configure history to ignore commands starting with space to avoid leaking
  # our bootstrap script into the user's history. At this point, we unset this
  # option to avoid turning on this behavior and potentially confusing the user.
  # If they set it in their config files, their value will be respected.
  unsetopt hist_ignore_space

  # The temporary files used to track generator PIDs.  We'll fill these in later,
  # if we execute any generator commands.
  _ROOK_GENERATOR_PIDS_STARTED_TMP_FILE=""
  _ROOK_GENERATOR_PIDS_COMPLETED_TMP_FILE=""
  # Flag to indicate whether the current command is a generator command.
  # We use an empty string as the sentinel value (rather than unsetting) for
  # compatibility with `setopt nounset`.
  _ROOK_GENERATOR_COMMAND=""
  # Make sure we delete generator PID files when the shell exits, if they exist.
  __rook_generator_pid_file_cleanup() {
    if [[ -f $_ROOK_GENERATOR_PIDS_STARTED_TMP_FILE ]]; then
      command -p rm $_ROOK_GENERATOR_PIDS_STARTED_TMP_FILE
    fi
    if [[ -f $_ROOK_GENERATOR_PIDS_COMPLETED_TMP_FILE ]]; then
      command -p rm $_ROOK_GENERATOR_PIDS_COMPLETED_TMP_FILE
    fi
  }
  trap __rook_generator_pid_file_cleanup EXIT

  # Writes a hex-encoded JSON message to the pty.
  rook_send_json_message () {
      # Sends a message to the controlling terminal as a DCS control sequence.
      # Note that because the JSON string may contain characters that we don't control (including
      # unicode), we encode it as hexadecimal string to avoid prematurely calling unhook if
      # one of the bytes in JSON is 9c (ST) or other (CAN, SUB, ESC).
      local msg=$(rook_hex_encode_string "$1")
      # We send the InitShell hook via OSCs when on WSL and via DCSs otherwise.
      if [ "$ROOK_USING_WINDOWS_CON_PTY" = true ]; then
        printf $OSC_START$DCS_JSON_MARKER$OSC_PARAM_SEPARATOR$msg$OSC_END
      else
        printf "%b%b%s%b" $DCS_START $DCS_JSON_MARKER $msg $DCS_END
      fi
  }

  # Emit the ExitShell hook right before the remote shell exits so the Rook
  # client can drop per-session resources (specifically the
  # `ssh … remote-server-proxy` child that holds a multiplexed channel on
  # the foreground ssh ControlMaster). This avoids a hang where the master
  # waits on orphaned slave channels when the user ends their interactive
  # session.
  #
  # Only relevant for remote SSH shells. ROOK_IS_SSH is exported to "1"
  # by `rook_ssh_helper` on the remote side of a Rook-managed SSH session
  # and is unset everywhere else (local shells, subshells, docker
  # sandboxes, etc.), so the hook only fires where a remote-server-proxy
  # actually needs tearing down.
  #
  # Installed after rook_send_json_message is defined so the handler is
  # callable the moment the hook is registered.
  if [[ "$ROOK_IS_SSH" == "1" ]]; then
      __rook_emit_exit_shell() {
          if [[ -n "$ROOK_SESSION_ID" ]]; then
              rook_send_json_message \
                  "{\"hook\": \"ExitShell\", \"value\": {\"session_id\": $ROOK_SESSION_ID}}"
          fi
      }
      # zshexit_functions is zsh's idiomatic exit-hook mechanism. We prefer
      # it over `trap ... EXIT` for a few reasons:
      #   1. It is additive: appending to the array composes with the
      #      existing `trap __rook_generator_pid_file_cleanup EXIT` above.
      #      Using `trap ... EXIT` here would replace that handler (zsh, like
      #      bash, only allows one trap per signal) and we would have to
      #      manually re-invoke the generator cleanup.
      #   2. It runs in the main shell's context, unlike `trap ... EXIT`
      #      which can execute in a subshell under some zsh versions --
      #      problematic here because we need to write to the parent shell's
      #      controlling PTY to emit the ExitShell hook.
      #   3. It also fires on SIGHUP-triggered exits, so a single
      #      registration covers both normal exit (exit, logout, Ctrl-D) and
      #      connection-drop cases.
      zshexit_functions+=(__rook_emit_exit_shell)
  fi

  rook_maybe_send_reset_grid_osc() {
      if [ "$ROOK_USING_WINDOWS_CON_PTY" = true ]; then
          printf $OSC_RESET_GRID
      fi
  }

  # Hex-encodes the given argument and writes it to the PTY, wrapped in the OSC
  # sequences for generator output.
  #
  # Usage:
  #   rook_send_generator_output_osc $my_output
  #
  # The payload of the OSC is "<content_length>;<hex-encoded content>".
  #
  # Note: If we're on windows, we send a reset grid to erase any cursor mutations caused by
  # the in-band command.
  rook_send_generator_output_osc() {
      local hex_encoded_message=$(rook_hex_encode_string "$1")
      local byte_count=$(LC_ALL="C"; printf "${#hex_encoded_message}")
      printf "%b%i;%s%b" $OSC_START_GENERATOR_OUTPUT $byte_count $hex_encoded_message $OSC_END_GENERATOR_OUTPUT
      rook_maybe_send_reset_grid_osc
  }

  # Executes the given command and writes its output to the pty wrapped in a
  # DCS.  The written DCS conforms to a basic schema including other metadata:
  #   "<command_id>;<command_output>;<exit_code>"
  # where command_id is the ID given as the first argument to this function,
  # exit_code is the exit code of the executed command, and command_output is
  # the output itself.
  _rook_execute_command() {
    local command_id=$1
    # This is shorthand to slice the 2nd-nth arguments of this function (i.e.
    # the command array) into its own array. The first argument is the
    # command_id stored above. Zsh arrays are 1-indexed, hence slicing from
    # index 2 rather than index 1.
    local -a command
    command=("${@:2}")
    # Declare raw_output prior to actually assigning it, because `local` is a command itself, which
    # interferes with capturing the exit code via $? (it overwrites $? with the 0, because the
    # 'local' command always succeeds).
    local raw_output
    # Command substitution only captures stdout, so redirect stderr to stdout.
    # Note that we use `eval` here to actually execute the command, because some shell syntax
    # that may be used in the command might not be valid in a command substitution (e.g. the
    # '$(<command>)' syntax).
    # Also note that zsh variables can contain null characters, so this doesn't require any special
    # handling.
    raw_output=$(eval "$command" 2>&1)
    local exit_code=$?
    rook_send_generator_output_osc "$command_id;$raw_output;$exit_code"
  }

  # Runs the given command in the background, records its PID in
  # _ROOK_GENERATOR_PIDS_STARTED_TMP_FILE, and adds its PID from the file when
  # the job is completed.
  _rook_run_generator_command_internal() {
    _rook_execute_command "$@" &
    # $! contains the PID of the most recently backgrounded command.
    local pid=$!
    echo $pid >> $_ROOK_GENERATOR_PIDS_STARTED_TMP_FILE
    wait $pid 2> /dev/null

    # If the exit code of the backgrounded _rook_execute_command process is non-zero,
    # the call to send the generator output failed (most likely because this is being
    # executed in an old zsh version that doesn't support some syntax in
    # _rook_execute_command function itself). In this case, send empty output with
    # exit code 1 to indicate generator execution failed.
    if [[ $? -ne 0 ]]; then
        rook_send_generator_output_osc "$1;;1"
    fi

    # Add the PID to the completed generators PID file.
    #
    # The completed generator PIDs file may not exist if this generator was (by
    # error) left running/not cancelled properly in rook_preexec.
    if [[ -f $_ROOK_GENERATOR_PIDS_COMPLETED_TMP_FILE ]]; then
      echo $pid >> $_ROOK_GENERATOR_PIDS_COMPLETED_TMP_FILE
    fi
  }

  # Executes a generator command in the background, where the first argument is
  # the "command ID" assigned by the Rust app and the second-nth arguments
  # specify the command to be run.
  #
  # Note that the command string should be single-quoted so any variables are
  # not substituted until the command string is actually evaluated.
  #
  # Usage:
  #   rook_run_generator_command <command_id> '<command> <arg1> ... <argn>'
  rook_run_generator_command() {
    # Setting this environment variable prevents rook_precmd from emitting the
    # 'Block started' hook to the Rust app.
    _ROOK_GENERATOR_COMMAND=1

    # Ensure the started and completed generator PID files exist.
    if [[ -z $_ROOK_GENERATOR_PIDS_STARTED_TMP_FILE || ! -f $_ROOK_GENERATOR_PIDS_STARTED_TMP_FILE ]]; then
      _ROOK_GENERATOR_PIDS_STARTED_TMP_FILE="$(command -p mktemp)"
    fi
    if [[ -z $_ROOK_GENERATOR_PIDS_COMPLETED_TMP_FILE || ! -f $_ROOK_GENERATOR_PIDS_COMPLETED_TMP_FILE ]]; then
      _ROOK_GENERATOR_PIDS_COMPLETED_TMP_FILE="$(command -p mktemp)"
    fi

    # To minimize latency and prevent the user from being blocked from entering a command,
    # cache the user's precmd_functions and only register rook_precmd. In the rook_precmd
    # execution following this generator command, the user's precmd_functions are restored.
    _USER_PRECMD_FUNCTIONS=($precmd_functions)
    # Remove all precmd functions other than ones defined by us or p10k.  If we remove the
    # p10k precmd functions, p10k will see that we started running an in-band command but
    # not know when it finishes, which causes a variety of undesirable side-effects.
    precmd_functions=(${(M)precmd_functions:#*(rook|p9k)*})

    (_rook_run_generator_command_internal "$@" &)
  }

  # Returns exit code 1 if the given argument starts with 'rook_run_generator_command'.
  _is_rook_generator_command() {
    [[ "$1" != *"rook_run_generator_command"* ]]
  }

  # Note that this is very performance sensitive code, so try not to
  # invoke any external commands in here.
  rook_preexec () {
      local rook_escaped_command="$(rook_escape_json $1)"
      rook_send_json_message "{\"hook\": \"Preexec\", \"value\": {\"command\": \"$rook_escaped_command\", \"session_id\": $ROOK_SESSION_ID}}"
      rook_maybe_send_reset_grid_osc

      # If this preexec is called for user command, kill ongoing generator command jobs and clean
      # up the bookkeeping temp files used to bookkeep.
      if _is_rook_generator_command "$1" && [[ -f $_ROOK_GENERATOR_PIDS_STARTED_TMP_FILE ]] && [[ -f $_ROOK_GENERATOR_PIDS_COMPLETED_TMP_FILE ]]
        then
        # Read PIDs from the started generators tmp file that are not present in
        # the completed generators tmp file into a zsh array.
        #
        # The logic used to be the following:
        #
        # pids=($(command -p comm -23 $_ROOK_GENERATOR_PIDS_STARTED_TMP_FILE $_ROOK_GENERATOR_PIDS_COMPLETED_TMP_FILE))
        #
        # However, that requires that the files are sorted, which we do not enforce (the OS can assign PIDs
        # in any order).  While we could sort the files and then compare them, the files are expected to be
        # small, so we avoid the overhead of spawning multiple processes and instead do the comparison
        # manually.
        completed_pids=(${(f)"$(<$_ROOK_GENERATOR_PIDS_COMPLETED_TMP_FILE)"})
        spawned_pids=(${(f)"$(<$_ROOK_GENERATOR_PIDS_STARTED_TMP_FILE)"})
        pids=(${spawned_pids:|completed_pids})

        # If the array is not empty, kill the ongoing pids.
        if [[ ! -z $pids ]]; then
          # Suppress stderr output; kill writes to stderr if any of the given
          # PIDS are not running (which might rarely be the case due to race
          # conditions in checking which PIDS to cancel and this kill command.
          (kill -9 $pids 2>&1) >/dev/null
        fi
      fi
  }

  # The git prompt's git commands are read-only and should not interfere with
  # other processes. This environment variable is equivalent to running with `git
  # --no-optional-locks`, but falls back gracefully for older versions of git.
  # See git(1) for and git-status(1) for a description of that flag.
  #
  # We wrap in a local function instead of exporting the variable directly in
  # order to avoid interfering with manually-run git commands by the user.
  rook_git () {
    GIT_OPTIONAL_LOCKS=0 command git "$@"
  }

  # Clears the line editor's buffer and, if the active keymap is "vicmd" (vi command/normal
  # mode), switches back to "viins" (its insert companion).
  function rook_kill_buffer_and_reset_insert_mode () {
    zle kill-buffer
    if [[ $KEYMAP == vicmd ]]; then
      zle -K viins
    fi
  }
  zle -N rook_kill_buffer_and_reset_insert_mode

  # Note that this is very performance sensitive code, so try not to
  # invoke any external commands in here.
  rook_precmd () {
      # $? is the exit code of the last command executed in this process, which
      # includes commands run within function definitions. So we capture the
      # exit code from $? in precmd first, prior to executing any other
      # commands so we can be assured that it represents the exit code of the
      # previously run user command (as opposed to any of the commands executed
      # in this function below).
      local exit_code=$?
      local next_block_id="precmd-$ROOK_SESSION_ID-$((block_id++))"

      rook_send_json_message "{\"hook\": \"CommandFinished\", \"value\": {\"exit_code\": $exit_code, \"next_block_id\": \"$next_block_id\", \"session_id\": $ROOK_SESSION_ID}}"
      rook_maybe_send_reset_grid_osc

      # If this is being called for a generator command, short circuit and send an unpopulated
      # precmd payload (except for pwd), since we don't re-render the prompt after generator commands
      # are run.
      if [ -n "$_ROOK_GENERATOR_COMMAND" ]; then
        # Restore the user's precmd_functions, since they were un-registered prior to executing
        # the generator.
        precmd_functions=($_USER_PRECMD_FUNCTIONS)

        _ROOK_GENERATOR_COMMAND=""
        rook_send_json_message "{\"hook\": \"Precmd\", \"value\": {
        \"exit_code\": $exit_code,
        \"next_block_id\": \"$next_block_id\",
        \"pwd\": \"\",
        \"ps1\": \"\",
        \"git_head\": \"\",
        \"git_branch\": \"\",
        \"virtual_env\": \"\",
        \"conda_env\": \"\",
        \"node_version\": \"\",
        \"session_id\": $ROOK_SESSION_ID,
        \"is_after_in_band_command\": true
        }}"
        return 0
      fi

      # If the files for tracking generator PIDs exist, clear them.
      if [[ -n $_ROOK_GENERATOR_PIDS_STARTED_TMP_FILE && -f $_ROOK_GENERATOR_PIDS_STARTED_TMP_FILE ]]; then
          echo "" > $_ROOK_GENERATOR_PIDS_STARTED_TMP_FILE
        fi
        if [[ -n $_ROOK_GENERATOR_PIDS_COMPLETED_TMP_FILE && -f $_ROOK_GENERATOR_PIDS_COMPLETED_TMP_FILE ]]; then
          echo "" > $_ROOK_GENERATOR_PIDS_COMPLETED_TMP_FILE
        fi

      # Reset the custom kill-buffer binding as the user's zshrc (which is sourced after zshrc_rook)
      # could have added a bindkey. This won't have any user-impact because these shortcuts are only run
      # in the context of the zsh line editor, which isn't displayed in Rook.
      #
      # We explicitly rebind on every standard keymap (not just "main", which is only a link to
      # whichever of emacs/viins is currently selected) because a user's rc file can switch editing
      # modes after we've bound "main" (e.g. `bindkey -v`, as used by the "cursor_mode" zsh function
      # and by prezto). `bindkey -v` re-links "main" to "viins" and leaves "vicmd" (vi command mode)
      # bound to its default of up-history. If the active keymap when Rook sends its pre-command ^P
      # ends up being one we didn't rebind, the clear becomes a no-op and any leftover bootstrap bytes
      # still sitting in the line editor's buffer get echoed alongside the next command.
      # See https://github.com/FJRG2007/rook/issues/7099.
      local rook_keymap
      for rook_keymap in main emacs viins vicmd; do
        bindkey -M "$rook_keymap" '^P' rook_kill_buffer_and_reset_insert_mode 2>/dev/null || :
      done

      # Reset the custom input-reporting binding as well, in case it was overridden
      # by the user's zshrc.
      # This is arbitrarily bound to ESC-i in all supported shells ("i" for input).
      # Binding to ESC-1 caused bootstrap failures with vi keybindings.
      bindkey -r '\ei'
      bindkey '\ei' rook_report_input

      # Introduce keybinding to switch prompt modes (PS1 vs built-in Rook prompt).
      # This is arbitrarily bound to ESC-p in all supported shells ("p" for PS1),
      # and we can change it to any other keybinding if needed.
      bindkey -r '\ep'
      bindkey '\ep' rook_change_prompt_modes_to_ps1

      # Introduce keybinding to switch prompt modes (PS1 vs built-in Rook prompt).
      # This is arbitrarily bound to ESC-w in all supported shells ("w" for Rook prompt),
      # and we can change it to any other keybinding if needed.
      bindkey -r '\ew'
      bindkey '\ew' rook_change_prompt_modes_to_rook_prompt

      local escaped_pwd
      if [ -n "${WSL_DISTRO_NAME:-}" ]; then
        # In WSL, avoid symlinks b/c on Windows `std::fs` is unable to resolve symlink inside WSL containers.
        escaped_pwd=$(rook_escape_json "$(pwd -P)")
      else
        escaped_pwd=$(rook_escape_json "$PWD")
      fi

      local escaped_virtual_env=""
      local escaped_conda_env=""
      local escaped_node_version=""
      local escaped_git_head=""
      local escaped_git_branch=""
      local escaped_kube_config=""

      # Only fill these fields once we've finished bootstrapping, as the
      # blocks created during the bootstrap process don't have visible
      # prompts, and we don't want to invoke `git` before we've sourced the
      # user's rcfiles and have a fully-populated PATH.
      if [[ -n $ROOK_BOOTSTRAPPED ]]; then
        if [[ -n ${VIRTUAL_ENV:-} ]]; then
          escaped_virtual_env=$(rook_escape_json $VIRTUAL_ENV)
        fi

        if [[ -n ${CONDA_DEFAULT_ENV:-} ]]; then
          escaped_conda_env=$(rook_escape_json $CONDA_DEFAULT_ENV)
        fi

          # Get the Node.js version, but only when the Node.js Version chip is enabled.
          # Rook sets ROOK_PROMPT_NODE_VERSION_ENABLED to "0" when the chip is not in the
          # prompt (defaulting to enabled when unset), so we avoid spawning `node` on
          # every prompt when the chip is not shown.
          if [[ "$ROOK_PROMPT_NODE_VERSION_ENABLED" != "0" ]] && command -v node > /dev/null 2>&1; then
              # Check for package.json in current directory and parent directories
              local current_dir="$PWD"
              local found_package_json=false
              local package_json_dir=""
              while [[ -n "$current_dir" ]]; do
                  if [[ -f "$current_dir/package.json" ]]; then
                      found_package_json=true
                      package_json_dir="$current_dir"
                      break
                  fi
                  [[ "$current_dir" == "/" ]] && break
                  # Strip the last path segment without spawning `dirname`.
                  current_dir="${current_dir%/*}"
                  [[ -z "$current_dir" ]] && current_dir="/"
              done
              
              # Only show node version if package.json is within a git repository
              if [[ "$found_package_json" = true ]]; then
                  local git_dir="$package_json_dir"
                  local in_git_repo=false
                  while [[ -n "$git_dir" ]]; do
                      if [[ -d "$git_dir/.git" ]]; then
                          in_git_repo=true
                          break
                      fi
                      [[ "$git_dir" == "/" ]] && break
                      git_dir="${git_dir%/*}"
                      [[ -z "$git_dir" ]] && git_dir="/"
                  done
                  
                  if [[ "$in_git_repo" = true ]]; then
                      # Cache the resolved version keyed on PWD + PATH so we only spawn
                      # `node --version` when the directory or PATH changes (PATH changes
                      # on `nvm use`). The cache vars are global (no `local`) so they
                      # persist across precmd invocations.
                      local node_cache_key="$PWD:$PATH"
                      if [[ "$node_cache_key" == "$_ROOK_NODE_VERSION_CACHE_KEY" ]]; then
                          escaped_node_version="$_ROOK_NODE_VERSION_CACHE_VALUE"
                      else
                          local node_version=$(node --version 2>/dev/null)
                          if [[ -n "$node_version" ]]; then
                              escaped_node_version=$(rook_escape_json "$node_version")
                          fi
                          _ROOK_NODE_VERSION_CACHE_KEY="$node_cache_key"
                          _ROOK_NODE_VERSION_CACHE_VALUE="$escaped_node_version"
                      fi
                  fi
              fi
          fi

        if [[ -n ${KUBECONFIG:-} ]]; then
          escaped_kube_config=$(rook_escape_json $KUBECONFIG)
        fi

        # Note: We explicitly do _not_ use command -p here, as `git` is a command that can be
        # installed in non-standard locations and so is not always available on the shell's
        # default PATH. Instead, we rely on the active PATH, as if the user doesn't have git
        # available to their session, it is unlikely they will be looking for git branch
        # information from the prompt.
        local git_branch=""
        local git_head=""
        if command -v git >/dev/null 2>&1; then
          git_branch=$(rook_git symbolic-ref --short HEAD 2> /dev/null)
          # The git branch the user is on, or the git commit hash if they're not on a branch.
          git_head="${git_branch:-$(rook_git rev-parse --short HEAD 2> /dev/null)}"
        fi
        escaped_git_head=$(rook_escape_json "$git_head")
        escaped_git_branch=$(rook_escape_json "$git_branch")
      fi


      # We also pass the shell's notion of `honor_ps1` to ensure it's synced correctly on the Rook-side for prompt handling.
      # This is passed as a "real boolean" via the JSON payload (string interpolated into JSON string below).
      local honor_ps1
      if [[ "$ROOK_HONOR_PS1" == "1" ]]; then
        honor_ps1="true"
      else
        honor_ps1="false"
      fi

      local escaped_json="{\"hook\": \"Precmd\", \"value\": {
      \"exit_code\": $exit_code,
      \"next_block_id\": \"$next_block_id\",
      \"pwd\": \"$escaped_pwd\",
      \"ps1\": \"\",
      \"honor_ps1\": $honor_ps1,
      \"rprompt\": \"\",
      \"git_head\": \"$escaped_git_head\",
      \"git_branch\": \"$escaped_git_branch\",
      \"virtual_env\": \"$escaped_virtual_env\",
      \"conda_env\": \"$escaped_conda_env\",
      \"node_version\": \"$escaped_node_version\",
      \"kube_config\": \"$escaped_kube_config\",
      \"session_id\": $ROOK_SESSION_ID
      }}"
      rook_send_json_message "$escaped_json"
  }

  rook_clear_on_next_block () {
      rook_send_json_message '{"hook": "ClearOnNextBlock"}'
  }


  # Format a string value according to JSON syntax.
  rook_escape_json () {
      # Explanation of the sed replacements (each command is separated by a `;`):
      # s/(["\\])/\\\1/g - Replace all double-quote (") and backslash (\) characters with the escaped versions (\" and \\)
      # s/\b/\\b/g - Replace all backspace characters with \b
      # s/\t/\\t/g - Replace all tab characters with \t
      # s/\f/\\f/g - Replace all form feed characters with \f
      # s/\r/\\r/g - Replace all carriage return characters with \r
      # $!s/$/\\n/ - On every line except the last, insert the \n escape at the end of the line
      #              Note: sed acts line-by-line, so it doesn't see the literal newline characters to replace
      #
      # tr -d '\n' - Remove the literal newlines from the final output
      #
      # Additional note: In a shell script between single quotes ('), no escape sequences are interpreted.
      # To work around that and insert the literal values into the regular expressions, we stop the single-quote,
      # then add the literal using ANSI-C syntax ($'\t'), then start a new single-quote. That is the meaning
      # behind the various `'$'\b''` blocks in the command. All of these separate strings are then concatenated
      # together to form the full argument to send to sed.
      #
      # We also use 'command sed' to ensure that we aren't accidentally executing an alias or function named 'sed'
      command -p sed -E 's/(["\\])/\\\1/g; s/'$'\b''/\\b/g; s/'$'\t''/\\t/g; s/'$'\f''/\\f/g; s/'$'\r''/\\r/g; $!s/$/\\n/' <<<"$*" | command -p tr -d '\n'
  }

  rook_escape_ps1 () {
      # Turns out that the processed prompt is a complicated data structure that includes lots of
      # information that's passed to the shell (including the actual shell, version, working directory
      # and, well, the prompt itself). What is more, prompt can also include emojis - unicode characters
      # that sometimes contain special bytes (ie. ST, CAN or SUB) that are otherwise used as unhook
      # triggers for the precmd. Instead of escaping those and extracting the value of the prompt itself,
      # we simply convert the entire data structure into a single line hex string, which Rook
      # later decodes and sends to the grid to show the prompt.
      # Note: before converting the prompt to a hex string, we remove the multi-line newlines and replace
      # them with a single space (to avoid prompts that span multiple empty lines).
      command -p tr '\n\n' ' ' <<< "$*" | command -p od -An -v -tx1 | command -p tr -d ' \n'

  }

  # rook_hex_encode_string encodes the entire DCS string (JSON) with od making it essentially
  # a very long hexadecimal string.
  # Afterwards it's decoded in rust and parsed as usual.
  # Accepts one argument: DCS JSON string
  rook_hex_encode_string () {
    printf '%s' "$1" | command -p od -An -v -tx1 | command -p tr -d ' \n'
  }

  rook_completions_hex_encode_into () {
    setopt localoptions nomultibyte
    # `LC_ALL=C` keeps indexing byte-wise, so a multibyte character encodes as its UTF-8 bytes rather than its code point.
    local LC_ALL=C
    local __rook_hex_var="$1"
    local __rook_hex_in="$2"
    # This branch is faster for longer values.
    if (( ${#__rook_hex_in} > 256 )); then
      typeset -g "$__rook_hex_var=$(printf '%s' "$__rook_hex_in" \
        | command -p od -An -v -tx1 | command -p tr -d ' \n')"
      return
    fi
    # This branch is faster for shorter values. The "for" loop is O(n²) which is fine for short
    # values, bad for long values. The case above avoids that at the cost of using piping into
    # subprocesses instead.
    local __rook_hex_i __rook_hex_char __rook_hex_byte __rook_hex_acc=""
    for (( __rook_hex_i = 1; __rook_hex_i <= ${#__rook_hex_in}; __rook_hex_i++ )); do
      __rook_hex_char=${__rook_hex_in[__rook_hex_i]}
      __rook_hex_byte=$(( [##16] #__rook_hex_char ))
      __rook_hex_acc+=${(l:2::0:)${(L)__rook_hex_byte}}
    done
    typeset -g "$__rook_hex_var=$__rook_hex_acc"
  }

  rook_hex_decode_string () {
    if command -pv xxd >/dev/null 2>&1; then
      printf '%s' "$1" | command -p xxd -p -r
    else
      local hex="$1" i
      for ((i = 0; i < ${#hex}; i += 2)); do
        builtin printf "\x${hex:$i:2}"
      done
    fi
  }

  # We set precmd and preexec hooks in order to set the title for the idle
  # terminal and the terminal running a command respectively. This is so we
  # provide a reasonable default behavior in the case where the user doesn't
  # have any shell scripts to set titles.
  #
  # If another shell script also has precmd/preexec hooks to set the title,
  # we won't be clobbering them because our hooks will run first.
  # If the ROOK_DISABLE_AUTO_TITLE variable is set, we won't set the title at all.
  # This way, setting the terminal title in a echo command and escape
  # sequences will work (a single command to set the title normally will get
  # clobbered by a precmd hook)."
  function rook_title {
    # Disable oh-my-zsh default title otherwise.
    DISABLE_AUTO_TITLE="true"

    setopt localoptions nopromptsubst

    # Don't set the title if inside emacs, unless using vterm
    [[ -n "${INSIDE_EMACS:-}" && "${INSIDE_EMACS:-}" != vterm ]] && return

    title="%25<..<$1" # shorten the tab_title to 25 characters
    print -Pn "\e]0;${title:q}\a" # set tab & window name (they're the same in Rook)
  }

  ZSH_THEME_TERM_TITLE_IDLE="%~"
  ZSH_THEME_TERM_TAB_TITLE_IDLE_REMOTE="%m:%~"

  # Runs before showing the prompt
  function rook_set_title_idle_on_precmd {
    # If the user wants to set the title using oh-my-zsh, they can
    # set the ROOK_DISABLE_AUTO_TITLE flag.
    [[ "${ROOK_DISABLE_AUTO_TITLE:-}" != true ]] || return

    if [[ $ROOK_IS_LOCAL_SHELL_SESSION == "1" ]]; then
      rook_title "$ZSH_THEME_TERM_TITLE_IDLE"
    else
      rook_title "$ZSH_THEME_TERM_TAB_TITLE_IDLE_REMOTE"
    fi

  }

  # Runs before executing the command
  function rook_set_title_active_on_preexec {
    # If the user wants to set the title using oh-my-zsh, they can
    # set the ROOK_DISABLE_AUTO_TITLE flag.
    [[ "${ROOK_DISABLE_AUTO_TITLE:-}" != true ]] || return

    _is_rook_generator_command "$1" || return

    emulate -L zsh
    setopt extended_glob

    # split command into array of arguments
    local -a cmdargs
    cmdargs=("${(z)2}")
    # if running fg, extract the command from the job description
    if [[ "${cmdargs[1]}" = fg ]]; then
      # get the job id from the first argument passed to the fg command
      local job_id jobspec="${cmdargs[2]#%}"
      # logic based on jobs arguments:
      # http://zsh.sourceforge.net/Doc/Release/Jobs-_0026-Signals.html#Jobs
      # https://www.zsh.org/mla/users/2007/msg00704.html
      case "$jobspec" in
        <->) # %number argument:
          # use the same <number> passed as an argument
          job_id=${jobspec} ;;
        ""|%|+) # empty, %% or %+ argument:
          # use the current job, which appears with a + in $jobstates:
          # suspended:+:5071=suspended (tty output)
          job_id=${(k)jobstates[(r)*:+:*]} ;;
        -) # %- argument:
          # use the previous job, which appears with a - in $jobstates:
          # suspended:-:6493=suspended (signal)
          job_id=${(k)jobstates[(r)*:-:*]} ;;
        [?]*) # %?string argument:
          # use $jobtexts to match for a job whose command *contains* <string>
          job_id=${(k)jobtexts[(r)*${(Q)jobspec}*]} ;;
        *) # %string argument:
          # use $jobtexts to match for a job whose command *starts with* <string>
          job_id=${(k)jobtexts[(r)${(Q)jobspec}*]} ;;
      esac

      # override preexec function arguments with job command
      if [[ -n "${jobtexts[$job_id]}" ]]; then
        1="${jobtexts[$job_id]}"
        2="${jobtexts[$job_id]}"
      fi
    fi

    # cmd name only, or if this is sudo or ssh, the next cmd
    local CMD="${1[(wr)^(*=*|sudo|ssh|mosh|rake|-*)]:gs/%/%%}"
    local LINE="${2:gs/%/%%}"

    rook_title "$CMD"
  }

  function rook_report_input {
    local escaped_input="$(rook_escape_json "$BUFFER")"
    rook_send_json_message "{ \"hook\": \"InputBuffer\", \"value\": { \"buffer\": \"$escaped_input\", \"session_id\": $ROOK_SESSION_ID } }"
    # This prevents zsh from printing typeahead as background output after we've fetched it.
    BUFFER=""
  }
  zle -N rook_report_input

  # Runs the shell's own ctrl-r history widget as a foreground command.
  function rook_run_external_ctrl_r_widget () {
    local result=""
    case "$_ROOK_EXTERNAL_CTRL_R_WIDGET" in
      fzf-history-widget)
        local cursor_and_line="${1:-0:}"
        local char_cursor="${cursor_and_line%%:*}"
        local original_line="$(rook_hex_decode_string "${cursor_and_line#*:}")"
        local query="${original_line[1,$char_cursor]}"
        local fzf_default_opts
        if (( $+functions[__fzf_defaults] )); then
          fzf_default_opts="$(__fzf_defaults "" "${FZF_CTRL_R_OPTS-}")"
        else
          fzf_default_opts="--height ${FZF_TMUX_HEIGHT:-40%} ${FZF_DEFAULT_OPTS-} ${FZF_CTRL_R_OPTS-}"
        fi
        result="$(fc -rl 1 \
          | command -p awk '{ cmd=$0; sub(/^[ \t]*[0-9]+\**[ \t]+/, "", cmd); if (!seen[cmd]++) print cmd }' \
          | FZF_DEFAULT_OPTS="$fzf_default_opts" \
            FZF_DEFAULT_OPTS_FILE='' fzf --scheme=history --tiebreak=index +m --query="$query")"
        ;;
      atuin-search|atuin-search-viins|atuin-search-vicmd|_atuin_search_widget)
        # atuin writes its TUI to stdout; under plain command substitution that's a pipe, and
        # its cursor-position query (\x1b[6n) has nothing to answer it, so it bails during
        # startup. Swap stdout/stderr through fd 3, matching atuin's own zsh integration
        # (_atuin_search -> __atuin_search_cmd), so the TUI reaches the tty while the
        # selection is still captured via command substitution.
        result="$(ATUIN_SHELL=zsh atuin search -i 3>&1 1>&2 2>&3 3>&-)"
        # If the user has atuin's enter_accept config on, Enter both selects and runs the
        # command, signaled by this prefix; we only ever want the selection, never to run it,
        # so strip the prefix in both cases (see atuin's _atuin_search for the same check).
        result="${result#__atuin_accept__:}"
        ;;
    esac
    local rook_escaped_selection="$(rook_escape_json "$result")"
    rook_send_json_message "{ \"hook\": \"ExternalShellWidgetSelection\", \"value\": { \"buffer\": \"$rook_escaped_selection\", \"session_id\": $ROOK_SESSION_ID } }"
  }

  # Runs fzf's ctrl-t file-search widget as a foreground command.
  function rook_run_external_ctrl_t_widget () {
    local result=""
    if (( $+functions[__fzf_select] )); then
      result="$(__fzf_select)"
    else  # fzf < 0.48
      result="$(__fsel)"
    fi
    local rook_escaped_selection="$(rook_escape_json "$result")"
    rook_send_json_message "{ \"hook\": \"ExternalShellWidgetSelection\", \"value\": { \"buffer\": \"$rook_escaped_selection\", \"session_id\": $ROOK_SESSION_ID } }"
  }

  function rook_run_external_alt_c_widget () {
    setopt localoptions pipefail no_aliases 2>/dev/null
    local dir="$(
      FZF_DEFAULT_COMMAND=${FZF_ALT_C_COMMAND:-} \
      FZF_DEFAULT_OPTS=$(__fzf_defaults "--reverse --walker=dir,follow,hidden --scheme=path" "${FZF_ALT_C_OPTS-} +m") \
      FZF_DEFAULT_OPTS_FILE='' $(__fzfcmd) < /dev/tty
    )"
    [[ -n "$dir" ]] || return 0
    dir=$(builtin cd -q >/dev/null -- "$dir" && echo "$PWD" || echo "$dir")
    builtin cd -- "$dir"
  }

  function clear() {
      rook_send_json_message "{\"hook\": \"Clear\", \"value\": {\"session_id\": $ROOK_SESSION_ID}}"
  }

  function rook_finish_update {
    local update_id="$1"
    rook_send_json_message "{ \"hook\": \"FinishUpdate\", \"value\": { \"update_id\": \"$update_id\", \"session_id\": $ROOK_SESSION_ID} }"
  }

  # Check if the rook apt source file has been renamed to `warpdotdev.list.distUpgrade` due to an ubuntu version update.
  # If this occurred, we want to rename the source file back to `warpdotdev.list` to ensure updates can proceed.
  # We purposefully skip this if either the `warpdotdev.list` file already exists (indicating that the user has already
  # done this themselves) _or_ if a `warpdotdev.sources` file exists (which is the new Deb822 format for source files).
  # The `.sources` file could only exist if a user manually created it; Ubuntu doesn't create one automatically for the
  # rook source file due to a bug in its update flow where it considers our source file to be "invalid" because it
  # contains a `signed-by` key.
  function rook_handle_dist_upgrade {
      local source_file_name="$1"

      eval "$(command apt-config shell APT_SOURCESDIR 'Dir::Etc::sourceparts/d')"

      if [[ ! -e $APT_SOURCESDIR$source_file_name.list && \
          ! -e $APT_SOURCESDIR$source_file_name.sources && \
           -e $APT_SOURCESDIR$source_file_name.list.distUpgrade ]]; then
        # DO NOT DO THIS. We should never run a command for user with `sudo`. The only reason this is safe here is because
        # we insert this function into the input for the user to determine if they want to execute (we never run it on
        # their behalf without their permission).  To be transparent about what is being executed with sudo, we echo out the
        # command we're about to run.
        echo "Executing: sudo cp \"$APT_SOURCESDIR$source_file_name.list.distUpgrade\" \"$APT_SOURCESDIR$source_file_name.list\""
        sudo cp "$APT_SOURCESDIR$source_file_name.list.distUpgrade" "$APT_SOURCESDIR$source_file_name.list"
      fi
  }

  # Strips prompt constructs that zsh counts as visible "glitch" columns even
  # when they appear inside a %{...%} zero-width region, returning the result
  # in $REPLY. The explicit-width form %n{ is rewritten to %{ (preserving the
  # brace pairing), and the %G, %nG, and %-nG forms are removed entirely.
  # Neither change affects the rendered prompt bytes, only zsh's internal
  # width accounting. Literal %% escapes are matched first so that they cannot
  # form false positives (e.g. %%1{ renders as literal text and must be left
  # alone).
  function rook_strip_glitch_width_constructs() {
    setopt localoptions extendedglob
    local match mbegin mend
    REPLY=${1:-}
    REPLY=${REPLY//(#b)(%%|%<->\{|%(-|)(<->|)G)/${${match[1]:#%(-|)(<->|)G}/(#s)%<->\{(#e)/%\{}}
  }

  # Called live via PROMPT_SUBST on every prompt render. Uses ${(e)...} to recursively evaluate
  # _ROOK_RAW_PROMPT — expanding any embedded subshells like $(git_prompt_info) so their output
  # (which may contain %n{...%} glitch constructs) is visible before stripping. The stripped output
  # is returned for use inside %{...%} so that zsh's countprompt() sees zero glitch columns, keeping
  # its cursor-column model in sync with the physical cursor. Async prompt updates (zle reset-prompt)
  # re-invoke this automatically.
  function _rook_stripped_prompt() {
    [[ -z "${_ROOK_RAW_PROMPT:-}" ]] && return
    local REPLY
    rook_strip_glitch_width_constructs "${(e)_ROOK_RAW_PROMPT}"
    # Append %{%} (a zero-width no-op in zsh prompt syntax) so that command
    # substitution does not strip any trailing newlines from the prompt content.
    # %{%} is harmless: it outputs nothing and has no effect on width counting.
    print -rn -- "${REPLY}%{%}"
  }

  # Check whether the prompt-related variables have OSC prompt marker sequences,
  # and if not, wrap them with the appropriate markers so that we can direct the
  # prompt bytes to the appropriate grids.
  function rook_update_prompt_vars() {
    # 133;A and 133;B are standard prompt marker OSCs. We also follow the standard for the rprompt OSC below.
    # See https://learn.microsoft.com/en-us/windows/terminal/tutorials/shell-integration and
    # https://gitlab.freedesktop.org/terminal-wg/specifications/-/merge_requests/6/diffs for details.
    local prompt_prefix=$'\e]133;A\a'
    local rprompt_prefix=$'\e]133;P;k=r\a'
    local prompt_suffix=$'\e]133;B\a'
    if [[ "$ROOK_HONOR_PS1" != "1" ]] && [ "$ROOK_USING_WINDOWS_CON_PTY" = true ]; then
        local suffix="$prompt_suffix$OSC_RESET_GRID"
    else
        local suffix="$prompt_suffix"
    fi
    local prompt_prefix_with_cursor_marker="%{$prompt_prefix"
    local suffix_with_cursor_marker="$suffix%}"

    local prompt_prefix_with_cursor_marker_surrounded="%{$prompt_prefix%}"
    local suffix_with_cursor_marker_surrounded="%{$suffix%}"

    # Clear the user-defined prompt again, if using Rook's built-in prompt, before the command 
    # is rendered as it could have been reset by the user's zshrc or by setting 
    # the variable on the command line. This is used for same-line prompt and leads to the temporary
    # product behavior of Rook prompt switches only taking effect in new sessions.
    # Certain prompt plugins like p10k can reset the prompt to a non-empty value, after we've initially unset it.
    # Confirm that it is unset, if using built-in Rook prompt (update prompt vars is forced to run as the last precmd fn).
    if [[ "$ROOK_HONOR_PS1" != "1" ]]; then
      # If the PROMPT has its original value (i.e. we haven't modified it yet), we save it to SAVED_PROMPT
      # so we can recover it, via bindkey, if we switch back from Rook prompt to PS1 (intra-session).
      if [[ "$PROMPT" != "%{$prompt_prefix"*"%}" ]]; then
        SAVED_PROMPT=$PROMPT
      fi
      # Similarly, we also save the RPROMPT if it has its original value, for later use in intra-session switching.
      if [[ "${RPROMPT:-}" != "%{$rprompt_prefix$suffix%}" ]]; then
        SAVED_RPROMPT=${RPROMPT:-}
      fi
      
      # We don't unset the $PROMPT since we want to show the lprompt preview in the edit prompt modal (and onboarding blocks).
      # Note that the prompt grid is separate from the combined prompt/command grid and ONLY used for prompt previews, in the
      # case of the combined grid being enabled.
      # Clear the rprompt, so it doesn't accidentally appear in selections/any other relevant logic.
      unset RPROMPT
    fi


    if [[ -n "$PROMPT" ]]; then
      # We may have previously modified the prompt to add prompt and cursor
      # markers. If they exist, we remove the first occurrence of the prefix
      # and the last occurrence of the suffix, which should be the ones that
      # Rook has added, to avoid duplicating the prefix and suffix. Shell
      # parameter expansion is used to remove the first and last occurrences.
      # Specifically note that virtualenvs can add content to the prompt, so we need to 
      # remove the markers before re-adding them.
      # https://www.gnu.org/software/bash/manual/html_node/Shell-Parameter-Expansion.html
      if [[ "$PROMPT" == *"$prompt_prefix_with_cursor_marker_surrounded"* ]]; then
        local preceding_prefix=${PROMPT%%$prompt_prefix_with_cursor_marker_surrounded*}
        local following_prefix=${PROMPT#*$prompt_prefix_with_cursor_marker_surrounded}
        PROMPT=$preceding_prefix$following_prefix
      fi
      if [[ "$PROMPT" == *"$suffix_with_cursor_marker_surrounded"* ]]; then
        local preceding_suffix=${PROMPT%$suffix_with_cursor_marker_surrounded*}
        local following_suffix=${PROMPT##*$suffix_with_cursor_marker_surrounded}
        PROMPT=$preceding_suffix$following_suffix
      fi

      # In the case of prompt previews, we may have non-fully surrounded markers that we should remove too!
      # Specifically, we surround the ENTIRE prompt with cursor markers, to prevent the shell from moving its
      # internal cursor position when printing the prompt in the prompt preview grid. This is different
      # than the usual case, where we only surround the OSCs (prefix/suffix) with cursor markers.
      if [[ "$PROMPT" == *"$prompt_prefix_with_cursor_marker"* ]]; then
        local preceding_prefix=${PROMPT%%$prompt_prefix_with_cursor_marker*}
        local following_prefix=${PROMPT#*$prompt_prefix_with_cursor_marker}
        PROMPT=$preceding_prefix$following_prefix
      fi
      if [[ "$PROMPT" == *"$suffix_with_cursor_marker"* ]]; then
        local preceding_suffix=${PROMPT%$suffix_with_cursor_marker*}
        local following_suffix=${PROMPT##*$suffix_with_cursor_marker}
        PROMPT=$preceding_suffix$following_suffix
      fi

      # Update _ROOK_RAW_PROMPT — the user's true raw prompt content that
      # _rook_stripped_prompt evaluates at render time.
      #
      # After the marker-stripping above, $PROMPT is the inner content:
      #  - Exactly '$(_rook_stripped_prompt)': our placeholder from a previous
      #    run — _ROOK_RAW_PROMPT is already correct, leave it alone.
      #  - Contains '$(_rook_stripped_prompt)' but isn't exactly it (e.g. a
      #    plugin prepended or appended content around the placeholder):
      #    extract the prefix and suffix, strip them from _ROOK_RAW_PROMPT to
      #    get the base, then reassemble. This is idempotent.
      #  - Anything else: a genuine new prompt from the user.
      if [[ "$PROMPT" == '$(_rook_stripped_prompt)' ]]; then
        : # _ROOK_RAW_PROMPT is already correct
      elif [[ "$PROMPT" == *'$(_rook_stripped_prompt)'* ]]; then
        local _rook_extra_pfx="${PROMPT%%'$(_rook_stripped_prompt)'*}"
        local _rook_extra_sfx="${PROMPT#*'$(_rook_stripped_prompt)'}"
        local _rook_base="${_ROOK_RAW_PROMPT:-}"
        [[ -n "$_rook_extra_pfx" ]] && _rook_base="${_rook_base#"$_rook_extra_pfx"}"
        [[ -n "$_rook_extra_sfx" ]] && _rook_base="${_rook_base%"$_rook_extra_sfx"}"
        _ROOK_RAW_PROMPT="${_rook_extra_pfx}${_rook_base}${_rook_extra_sfx}"
      else
        _ROOK_RAW_PROMPT="$PROMPT"
      fi
      ORIGINAL_PROMPT=$PROMPT
      PROMPT="$prompt_prefix$PROMPT$suffix"
    fi

    if [[ -n "${RPROMPT:-}" && "${RPROMPT:-}" != *"$rprompt_prefix"* ]]; then
      RPROMPT="$rprompt_prefix$RPROMPT$suffix"
    fi

    # The "%{" and "%}" indicate to zsh that the sequence between the markers
    # should not change the position of the cursor.  This is necessary to
    # ensure proper rendering of the command grid when the combined prompt +
    # command length is longer than a single row.  When the prompt has a
    # non-zero width, the redraw of the initial line when it exceeds the max
    # columns leads to undesired artifacts in the command grid.
    # Note that we only need cursor markers for the prefix/suffix when using a combined prompt &
    # command grid.
    # If we are using the Rook prompt, we pass a "hidden left prompt" to the prompt
    # preview grid (the hidden prompt grid) with cursor markers surrounding the entire prompt.
    if [[ "$ROOK_HONOR_PS1" != "1" ]]; then
      # We purposefully surround this entire prompt with cursor markers to prevent
      # the shell from moving its internal state of the cursor position, for purposes
      # of printing the command with the Rook prompt.
      # Note that the Rook prompt is always ABOVE the combined grid in finished blocks
      # (same line prompt only affects the input editor with Rook prompt, not
      # finished blocks).
      if [[ -o promptsubst ]]; then
        # PROMPT_SUBST is on: subshells in PROMPT are evaluated at render time, so
        # dynamic glitch constructs (e.g. from $(git_prompt_info)) can appear. Use
        # the live-stripping wrapper to catch and strip them on every render.
        if [[ "$PROMPT" != "%{$prompt_prefix\$(_rook_stripped_prompt)$suffix%}" ]]; then
          PROMPT="%{$prompt_prefix\$(_rook_stripped_prompt)$suffix%}"
        fi
      else
        # PROMPT_SUBST is off: subshells are never evaluated in PROMPT, so glitch
        # constructs can only come from static content. Strip them now at precmd
        # time and embed the result directly, honoring the user's setting.
        local REPLY
        rook_strip_glitch_width_constructs "${_ROOK_RAW_PROMPT:-}"
        if [[ "$PROMPT" != "%{$prompt_prefix$REPLY$suffix%}" ]]; then
          PROMPT="%{$prompt_prefix$REPLY$suffix%}"
        fi
      fi
    # Otherwise, if we are using the PS1, we use the normal prompt markers.
    else
      if [[ "$PROMPT" != "%{"*"%}" ]]; then
        # We surround the non-printable OSCs with cursor markers to make sure the shell does NOT
        # account for them when keeping track of its internal cursor position.
        PROMPT="%{$prompt_prefix%}$ORIGINAL_PROMPT%{$suffix%}"
      fi
    fi

    # Do not synthesize an empty right prompt. Even without visible content, zsh reserves
    # right-prompt layout space and may corrupt wrapped command redraws in the command grid.
    if [[ -n "${RPROMPT:-}" && "${RPROMPT:-}" != "%{"*"%}" ]]; then
      RPROMPT="%{${RPROMPT:-}%}"
    fi

    # Ensure that this is always the last precmd hook. This prevents any other precmd hook, which might
    # modify $PROMPT, from interfering with our prompt-escaping logic.
    #
    # Remove rook_update_prompt_vars from the precmd_functions list and then re-append it to ensure it's
    # ordered last.
    precmd_functions=("${(@)precmd_functions[@]:#rook_update_prompt_vars}")
    precmd_functions+=(rook_update_prompt_vars)
  }

  # Switches to PS1 prompt by restoring the prompt/rprompt to their original values and flipping
  # ROOK_HONOR_PS1 to "1" (they had originally been unset for the Rook prompt). Resets the prompt,
  # forcing a re-print.
  function rook_change_prompt_modes_to_ps1() {
    PROMPT="$SAVED_PROMPT"
    RPROMPT="$SAVED_RPROMPT"
    ROOK_HONOR_PS1=1

    rook_update_prompt_vars
    zle .reset-prompt
  }

  # The following line creates a new widget with ZLE (the Zsh line editor) with the custom function above,
  # so we can reference this when we register it with a bindkey.
  zle -N rook_change_prompt_modes_to_ps1

  # Switches to Rook prompt by flipping ROOK_HONOR_PS1 to "0", which will result
  # in unsetting the PROMPT variables to avoid a double prompt. Resets the prompt, forcing
  # a re-print.
  function rook_change_prompt_modes_to_rook_prompt() {
    ROOK_HONOR_PS1=0

    rook_update_prompt_vars
    zle .reset-prompt
  }

  # The following line creates a new widget with ZLE (the Zsh line editor) with the custom function above,
  # so we can reference this when we register it with a bindkey.
  zle -N rook_change_prompt_modes_to_rook_prompt

  # The SSH logic only applies to local sessions, because we don't yet have support for bootstrapping
  # recursive SSH sessions.
  if [[ $ROOK_IS_LOCAL_SHELL_SESSION == "1" ]]; then
      # This helper function determines whether the user's ssh arguments imply
      # creation of a non-interactive session or otherwise would conflict with
      # our SSH wrapper.  Returns 0 for an interactive session; >0 otherwise.
      function is_interactive_ssh_session() {
          ARGS=()    # this array holds any positional arguments
          while [ $# -gt 0 ]; do
              # Initialize this to 1 before each call, as per getopts documentation.
              OPTIND=1
              # Parse through all ssh options, as defined in the ssh man pages.
              while getopts :1246AaCfgKkMNnqsTtVvXxYyb:c:D:e:F:i:L:l:m:O:o:p:R:S:W:w: OPTION; do
                  case $OPTION in
                      # -T disables pty allocation (aka a non-interactive session)
                      T) return 1;;
                      # -W implies -T
                      W) return 1;;
                      # The user provided an invalid option; kick it to real ssh.
                      \?) return 1;;
                      # The user omitted a required argument; kick it to real ssh.
                      :) return 1;;
                  esac
              done
              [ $? -eq 0 ] || return 2       # getopts failed
              [ $OPTIND -gt $# ] && break    # we reached the end of the parameters

              shift "$((OPTIND - 1))"  # skip all options processed so far
              ARGS+=($1)               # save first non-option argument (a.k.a. positional argument)
              shift                    # remove saved arg
          done

          # If there is more than one positional argument, the user is attempting to
          # run a command, not start an interactive session.  If there is less than
          # one positional argument, the user should be shown the usage text.
          if [[ ${#ARGS[@]} -ne 1 ]]; then
              return 1
          fi
      }

      function rook_ssh_helper() {
          local remote_session_id=$(command -p od -An -N8 -tu8 /dev/urandom 2>/dev/null | command -p tr -d ' \n')
          if [[ -z "$remote_session_id" || "$remote_session_id" == "0" ]]; then
              # If we cannot generate a non-zero random token, run plain SSH instead.
              command ssh "${@:1}"
              return
          fi

          # If the user's SSH config sets a RemoteCommand for this destination,
          # OpenSSH refuses to also run our bootstrap as a command-line remote
          # command, aborting with "Cannot execute command-line and remote
          # command." Rookification is structurally impossible there, so fall
          # back to plain SSH. `ssh -G` prints `remotecommand none` when unset.
          local user_remote_command=$(command ssh -G "${@:1}" 2>/dev/null | command -p sed -n 's/^remotecommand //p')
          if [[ -n "$user_remote_command" && "$user_remote_command" != "none" ]]; then
              command ssh "${@:1}"
              return
          fi

          # Hex-encode the ZSH environment script we use to bootstrap remote zsh b/c it contains control characters
          # We decode on the SSH server using xxd if its available, otherwise fall back to a for-loop over each byte
          # and use printf to convert back to plaintext
          local zsh_env_script=$(printf '%s' 'unsetopt ZLE RCS GLOBAL_RCS; ROOK_SESSION_ID='$remote_session_id'; ROOK_USING_WINDOWS_CON_PTY=@@USING_CON_PTY_BOOLEAN@@; _hostname=$(command -pv hostname >/dev/null 2>&1 && command -p hostname 2>/dev/null || command -p uname -n); _user=$(command -pv whoami >/dev/null 2>&1 && command -p whoami 2>/dev/null || echo $USER); _msg=$(printf "{\"hook\": \"InitShell\", \"value\": {\"session_id\": $ROOK_SESSION_ID, \"shell\": \"zsh\", \"user\": \"%s\", \"hostname\": \"%s\"}}" "$_user" "$_hostname" | command -p od -An -v -tx1 | command -p tr -d '"'"' \n'"'"'); printf '"'"'\e]9278;d;%s\x07'"'"' $_msg; unset _hostname _user _msg' | command -p od -An -v -tx1 | command -p tr -d ' \n')

          # Optionally attach to an existing ControlMaster the user already
          # runs for this destination instead of creating our own. Resolve
          # the user's configured ControlPath with `ssh -G` (which expands
          # tokens like %h/%p/%r/%C into a literal path), then verify the
          # master is alive with `ssh -O check`. Both probes are local-only
          # commands. On any failure we fall back to creating a Rook-owned
          # master, preserving the existing behavior.
          local control_path="$SSH_SOCKET_DIR/$ROOK_SESSION_ID"
          local control_master_mode="yes"
          local external_control_master="false"
          if [[ "$ROOK_SSH_REUSE_CONTROL_MASTER" == "1" ]]; then
              local user_control_path=$(command ssh -G "${@:1}" 2>/dev/null | command -p sed -n 's/^controlpath //p')
              case "$user_control_path" in
                  "" | none)
                      # No ControlPath configured for this destination.
                      ;;
                  *[![:alnum:]._/~@:+,-]*)
                      # The resolved path contains characters we cannot safely
                      # embed in the SSH hook JSON below (e.g. an unexpanded %
                      # token, quotes, or whitespace); fall back to a
                      # Rook-owned master.
                      ;;
                  *)
                      if command ssh -O check -o ControlPath="$user_control_path" "${@:1}" >/dev/null 2>&1; then
                          # A live master exists: multiplex through it and let
                          # the client know Rook does not own it.
                          control_path="$user_control_path"
                          control_master_mode="no"
                          external_control_master="true"
                      fi
                      ;;
              esac
          fi

          # Keep remote commands up-to-date with shell.rs & bash.sh.
          # Note that in this command, we're passing a string to the remote shell. Any variable expansions need to be
          # escaped with "''" to avoid the local shell from expanding them before they're passed to the remote shell.
          # We check the SHELL env var and use shell string manipulation to get the contents after the last slash to
          # determine what shell is the login shell on the remote machine.  We perform a preliminary check to see if
          # the remote shell is the Bourne shell to avoid asking it to parse later lines that use syntax it doesn't
          # support.
          command ssh -o ControlMaster=$control_master_mode -o ControlPath="$control_path" \
          -t "${@:1}" \
"
export TERM_PROGRAM='RookTerminal'
# Mark the remote side of a Rook-managed SSH session so the bootstrap
# body can distinguish it from local shells. Used to gate the ExitShell
# hook which tears down the remote-server-proxy subprocess.
export ROOK_IS_SSH='1'
test -n '$ROOK_CLIENT_VERSION' && export ROOK_CLIENT_VERSION='$ROOK_CLIENT_VERSION'
# Only forward the protocol version if it was set locally (i.e. the HOANotifications feature flag is on).
test -n '$ROOK_CLI_AGENT_PROTOCOL_VERSION' && export ROOK_CLI_AGENT_PROTOCOL_VERSION='$ROOK_CLI_AGENT_PROTOCOL_VERSION'
hook="'$(printf "{\"hook\": \"SSH\", \"value\": {\"socket_path\": \"'$control_path'\", \"remote_shell\": \"%s\", \"session_id\": '"$ROOK_SESSION_ID"', \"remote_session_id\": '"$remote_session_id"', \"external_control_master\": '"$external_control_master"'}}" "${SHELL##*/}" | command -p od -An -v -tx1 | command -p tr -d " \n")'"
printf '$OSC_START$DCS_JSON_MARKER$OSC_PARAM_SEPARATOR%s$OSC_END' "'$hook'"

if test "'"${SHELL##*/}" != "bash" -a "${SHELL##*/}" != "zsh"'"; then
  # Emulate the SSHD logic to print the MotD. Because the Rook SSH wrapper passes
  # a command to run, SSHD does a quiet login, updating utmp and other login
  # state, but not printing the MotD. For bash and zsh, this is instead handled
  # by our bootstrap script.
  if test ! -e "'$HOME/.hushlogin'"; then
    # This uses an if-else chain instead of a for-loop to avoid expansion issues on older shells.
    if test -r /etc/motd; then
      command -p cat /etc/motd
    elif test -r /run/motd; then
      command -p cat /run/motd
    elif test -r /run/motd.dynamic; then
      command -p cat /run/motd.dynamic
    elif test -r /usr/lib/motd; then
      command -p cat /usr/lib/motd
    elif test -r /usr/lib/motd.dynamic; then
      command -p cat /usr/lib/motd.dynamic
    fi
  fi
  # Likewise, emulate a login shell by sourcing /etc/profile
  if test -r /etc/profile; then
    . /etc/profile
  fi
  exec "'$SHELL'"
fi

case "'${SHELL##*/}'" in
  bash)
    exec -a bash bash --rcfile <(echo '"'
      command -p stty raw
      HISTCONTROL=ignorespace
      HISTIGNORE=" *"
      ROOK_SESSION_ID='$remote_session_id'
      ROOK_HONOR_PS1="'$ROOK_HONOR_PS1'"
      _hostname=$(command -pv hostname >/dev/null 2>&1 && command -p hostname 2>/dev/null || command -p uname -n)
      _user=$(command -pv whoami >/dev/null 2>&1 && command -p whoami 2>/dev/null || echo $USER)
      _msg=$(printf "{\"hook\": \"InitShell\", \"value\": {\"session_id\": $ROOK_SESSION_ID, \"shell\": \"bash\", \"user\": \"%s\", \"hostname\": \"%s\"}}" "$_user" "$_hostname" | command -p od -An -v -tx1 | command -p tr -d " \n")'"
      ROOK_USING_WINDOWS_CON_PTY=@@USING_CON_PTY_BOOLEAN@@
      if [[ "'$OS'" == Windows_NT ]]; then ROOK_IN_MSYS2=true; else ROOK_IN_MSYS2=false; fi
      printf '\''"'\e]9278;d;%s\x07'"'\'' \""'$_msg'"\"'
      unset _hostname _user _msg
    )
      ;;
  zsh) ROOK_TMP_DIR="'$(command -p mktemp -d rooktmp.XXXXXX)'"
    local ZSH_ENV_SCRIPT='$zsh_env_script'
    local ROOK_HONOR_PS1='$ROOK_HONOR_PS1'
    if [[ "'$?'" == 0 ]]; then
      if command -pv xxd >/dev/null 2>&1; then
        echo "'$ZSH_ENV_SCRIPT'" | command -p xxd -p -r > "'$ROOK_TMP_DIR'"/.zshenv
      else
        for i in {0..\$((\${#ZSH_ENV_SCRIPT} - 1))..2}; do
          builtin printf "'"\x${ZSH_ENV_SCRIPT:$i:2}"'"
        done > "'$ROOK_TMP_DIR'"/.zshenv
      fi
    else
      echo \"Failed to bootstrap rook. Continuing with a non-bootstrapped shell.\"
    fi
    TMPPREFIX="'$HOME/.zshtmp-'" ROOK_SSH_RCFILES="'${ZDOTDIR:-$HOME}'" ROOK_HONOR_PS1="'$ROOK_HONOR_PS1'" ZDOTDIR="'$ROOK_TMP_DIR'" exec -l zsh -g $TRACE_FLAG_IF_ROOK_SHELL_DEBUG_MODE
      ;;
esac
"
      }

      function ssh() {
          if is_interactive_ssh_session "$@"; then
              rook_send_json_message "{\"hook\": \"PreInteractiveSSHSession\", \"value\": {\"session_id\": $ROOK_SESSION_ID}}"

              # If the SSH wrapper is not enabled for this session, don't use it.
              if [ "$ROOK_USE_SSH_WRAPPER" = "1" ]; then
                local TRACE_FLAG_IF_ROOK_SHELL_DEBUG_MODE=""
                if [[ "$ROOK_SHELL_DEBUG_MODE" == "1" ]]; then
                    TRACE_FLAG_IF_ROOK_SHELL_DEBUG_MODE="-x"
                fi
                rook_ssh_helper "$@"
              else
                command ssh "$@"
              fi
          else
             command ssh "$@"
          fi
      }
  fi

  # Send a precmd message to the terminal to differentiate between the rook
  # bootstrap logic pasted into the PTY and the output of shell startup files.
  rook_precmd

  # Before calling rcfiles, print the MotD if this is a login shell. Normally,
  # login(1) or pam_motd(8) would do this. However, Rook does not use login(1)
  # for local sessions and for remote sessions, SSHD thinks it is starting a
  # non-interactive session, so it does not print PAM messages.
  if [[ -o login && ! -e "$HOME/.hushlogin" ]]; then
    for motd_file in /etc/motd /run/motd /run/motd.dynamic /usr/lib/motd /usr/lib/motd.dynamic; do
      if [[ -r "$motd_file" ]]; then
        command -p cat "$motd_file"
        break
      fi
    done
  fi

  # We need to restore the stty before any user bootstrap files are evaluated
  # in case they ask for user input
  setopt ZLE

  # If powerlevel instant prompt is on, we need to disable it because it
  # interferes with rook bootstrapping. The functionality is part of rook anyways.
  typeset -g POWERLEVEL9K_INSTANT_PROMPT=off

  # Add the Rook title precmd functions before the bootstrap sequence is sourced so that a user's custom tab title
  # behavior is respected over Rook's.
  precmd_functions+=(rook_set_title_idle_on_precmd)
  preexec_functions+=(rook_set_title_active_on_preexec)

  # Clean up after ourselves, restore ZDOTDIR, and remove the temporary directory in the ssh case.
  # We need to do this before the rcfiles are sourced, since rcfiles can reference ZDOTDIR.
  # In this case, we created a temp dir that starts with our template prefix and set the ZDOTDIR
  # to that dir.
  # Note that when called with a template, mktemp will work in the local directory, not the tmp filesystem.
  TEMPLATE_PREFIX="rooktmp."
  if [[ -n $ZDOTDIR ]]; then
      if [[ ${ZDOTDIR:0:${#TEMPLATE_PREFIX}} == $TEMPLATE_PREFIX ]]; then
            command -p rm -r "$ZDOTDIR"

            # Restore ZDOTDIR. Note that if it was originally unset, it'd be home instead of unset.
            ZDOTDIR=$ROOK_SSH_RCFILES
      fi
  fi

  # Load the EPOCHREALTIME variable from the zsh/datetime module so we can
  # accurately measure how long it takes to source the user's rcfiles.
  zmodload -F zsh/datetime +p:EPOCHREALTIME >/dev/null 2>&1

  # Make sure we force the locale used for number formatting to "C", to avoid
  # issues in locales that use a comma as the decimal separator.
  local rcfiles_start_time="$(LC_ALL="C"; echo $EPOCHREALTIME)"

  # This reflects the bootstrap sequence in a login shell. We want to
  # Do other shell startup first so we can ensure Rook goes last.

  # If this is a subshell, the user and system RC files have already been sourced.
  if [[ -z $ROOK_IS_SUBSHELL ]]; then
      if [[ -e "${ZDOTDIR:-$HOME}/.zshenv" ]]; then
          source "${ZDOTDIR:-$HOME}/.zshenv";
      fi
      if [[ -e /etc/zprofile ]]; then
          source /etc/zprofile;
      fi
      if [[ -e "${ZDOTDIR:-$HOME}/.zprofile" ]]; then
          source "${ZDOTDIR:-$HOME}/.zprofile";
      fi
      if [[ -e /etc/zshrc ]]; then
          source /etc/zshrc;
      fi
      if [[ -e "${ZDOTDIR:-$HOME}/.zshrc" ]]; then
          source "${ZDOTDIR:-$HOME}/.zshrc";
      fi
      if [[ -e /etc/zlogin ]]; then
          source /etc/zlogin;
      fi
      if [[ -e "${ZDOTDIR:-$HOME}/.zlogin" ]]; then
          source "${ZDOTDIR:-$HOME}/.zlogin";
      fi
  fi

  local rcfiles_end_time="$(LC_ALL="C"; echo $EPOCHREALTIME)"

  # If the user is running powerlevel10k and they selected "sparse" for the "Prompt Spacing"
  # option, this var will be true. It tells p10k to output an extra newline in its precmd function
  # which visually separates commands. These are generally undesired in Rook, since blocks provide
  # enough visual separation. Although generally benign, this causes an issue on Windows when
  # ConPTY is involved. The extra newline is output by p10k's precmd which runs after Rook's
  # precmd, i.e. after the "reset grid" sequence. It ends up causing Rook's grid content to be out
  # of sync with ConPTY, causing cursor positioning problems.
  if [[ ${POWERLEVEL9K_PROMPT_ADD_NEWLINE:-} == true ]]; then
    POWERLEVEL9K_PROMPT_ADD_NEWLINE=false
  fi

  # Returns exit code 1 if the command starts with 'rook_run_generator_command'.
  #
  # This is intended to be used as a zshaddhistory function to prevent in-band
  # generators from being added to the zsh history file.
  # zshaddhistory functions.
  #
  # See https://zsh.sourceforge.io/Doc/Release/Functions.html for more context
  # on the zshaddhistory hook.
  _rook_zshaddhistory() {
    _is_rook_generator_command "$1" && [[ "$1" != *"rook_run_external_ctrl_r_widget"* ]] && \
      [[ "$1" != *"rook_run_external_ctrl_t_widget"* ]] && \
      [[ "$1" != *"rook_run_external_alt_c_widget"* ]]
  }

  # Register this zshaddhistory hook after the user's RC files have been sourced,
  # to ensure that it gets added (the user's RC files could entirely reset the
  # hook function array).
  zshaddhistory_functions+=(_rook_zshaddhistory)

  # Append additional PATH entries if provided via ROOK_PATH_APPEND. This is after the user's RC
  # files are sourced in case they reset PATH (/etc/profile on Debian does this, for example).
  if [[ -n "${ROOK_PATH_APPEND:-}" ]]; then
    export PATH="$PATH:$ROOK_PATH_APPEND"
    unset ROOK_PATH_APPEND
  fi

  local -a shell_plugins

  if [[ ${precmd_functions[(I)_p9k_precmd]} != 0 ]]; then
    # The variable P9K_VERSION was added in the first version of p10k that
    # supports Rook, so if it is non-empty, the user is on a supported version.
    if [[ -z "${P9K_VERSION:-}" ]]; then
      # If the user is running an unsupported version of p10k, remove the precmd
      # hook entirely to prevent the p10k prompt from appearing in typeahead and
      # in the command grid.
      precmd_functions=(${precmd_functions:#_p9k_precmd})
      shell_plugins+=(p10k_unsupported)
    else
      shell_plugins+=(p10k)
    fi
  fi

  # Remove the pure precmd hook. Pure uses zsh-async to load
  # the prompt asynchronously, which means that the prompt can be
  # re-rendered (and entered as typeahead characters) once the async
  # callback completes. This means that any sort of `unset PS1` or
  # `unset PROMPT` calls in precmd don't work if the callback
  # completes after the `precmd`.
  if [[ ${precmd_functions[(I)prompt_pure_precmd]} != 0 ]]; then
    precmd_functions=(${precmd_functions:#prompt_pure_precmd})
    shell_plugins+=(pure)
  fi

  # Read through shell options to determine if the user has enabled vi mode.
  shell_options="$(setopt)"
  for i in ${(f)shell_options}; do
      if [[ "$i" == "vi" ]]; then
        vi_mode_in_opts=1
      fi
  done

  NVIM_RE='([[:space:]]|^)nvim([[:space:]]|$)'

  ZLE_BINDKEY="$(bindkey -lL main)"

  # Check if the shell's native "vi" option has been set.
  if [[ -n "${vi_mode_in_opts:-}" ]]; then
    shell_plugins+=(vi)

  # Check if nvim has been set as the default editor.
  # We don't check for vi/vim because it already the default in Linux,
  # which means it is set even for non-vim users who haven't deliberately
  # chosen it.
  elif [[ "${EDITOR:-}" =~ "$NVIM_RE" ]] || [[ "${VISUAL:-}" =~ "$NVIM_RE" ]]; then
    shell_plugins+=(vi)

  # Check if the zsh line editor bindings include vi-related commands.
  elif [[ "$ZLE_BINDKEY" = *viins* ]] || [[ "$ZLE_BINDKEY" = *vicmd* ]]; then
    shell_plugins+=(vi)

  # Check if the zsh-vi-mode plugin is being used.
  elif [[ ${precmd_functions[(I)zvm_init]} != 0 ]]; then
    shell_plugins+=(vi)
  fi

  # Detect whether ctrl-r has been rebound to fzf's or atuin's history widget.
  _ROOK_EXTERNAL_CTRL_R_WIDGET=""
  rook_ctrl_r_binding="$(bindkey -M main '^R' 2>/dev/null)"
  if [[ "$rook_ctrl_r_binding" == '"^R" '* ]]; then
    rook_ctrl_r_widget="${rook_ctrl_r_binding#\"^R\" }"
    case "$rook_ctrl_r_widget" in
      fzf-history-widget)
        _ROOK_EXTERNAL_CTRL_R_WIDGET="$rook_ctrl_r_widget"
        shell_plugins+=(fzf)
        ;;
      atuin-search|atuin-search-viins|atuin-search-vicmd|_atuin_search_widget)
        _ROOK_EXTERNAL_CTRL_R_WIDGET="$rook_ctrl_r_widget"
        shell_plugins+=(atuin)
        ;;
    esac
  fi

  if kernel_name="$(uname)"; then
    if [[ "$kernel_name" == "Darwin" ]]; then
      os_category="MacOS"
    elif [[ "$kernel_name" == "Linux" ]]; then
      os_category="Linux"
      default_os_release_filepath="/etc/os-release"
      fallback_os_release_filepath="/usr/lib/os-release"
      # We first try /etc/os-release and then try /usr/lib/os-release as a fallback.
      if test -f "$default_os_release_filepath"; then
        os_release_file="$default_os_release_filepath"
      elif test -f "$fallback_os_release_filepath"; then
        os_release_file="$fallback_os_release_filepath"
      fi
      if test -f "$os_release_file"; then
        linux_distribution="$(cat $os_release_file | sed -nE 's/^NAME="(.*)"$/\1/p')"
      fi
    fi
  fi

  # Restore the built-in bracketed-paste widget. This works around a buggy interaction we observed
  # with the bracketed-paste-magic plugin (included in oh-my-zsh by default), zsh's "allexport"
  # option (set -a), and Rook's bootstrapping code.
  # https://github.com/FJRG2007/rook/issues/11520
  zle -A .bracketed-paste bracketed-paste

  precmd_functions+=(rook_precmd rook_update_prompt_vars)
  preexec_functions+=(rook_preexec)

  ROOK_BOOTSTRAPPED=1

  # Unset the prompt environment variable: Rook doesn't render the user's default prompt.
  # We explicitly unset this for performance optimizations and so that the we can read the
  # command directly from the command grid without having to parse the prompt.
  export CONDA_CHANGEPS1=false

  rook_update_prompt_vars

  # Set history to flush after every command
  setopt share_history

  # Overrides compadd so that we can hook into parts of the completion stack
  # where richer completions data is available.
  #
  # Adapted from https://github.com/Valodim/zsh-capture-completion/blob/740fce754393513d57408bc585fde14e4404ba5a/capture.zsh#L51
  #
  # Licensed under the MIT license - Copyright (c) 2015 Vincent Breitmoser.
  function compadd () {
    # If we're not expecting to override compadd or if any of -O, -A or -D are given,
    # then just delegate to the main compadd.
    if [[ -z "${COMPADD_OVERRIDE}" || "${COMPADD_OVERRIDE}" == "false" || ${@[1,(i)(-|--)]} == *-(O|A|D)\ * ]]; then
        # if that is the case, just delegate and leave
        builtin compadd "$@"
        return $?
    fi

    # be careful with namespacing here, we don''t want to mess with stuff that
    # should be passed to compadd!
    typeset -a __hits __dscr __tmp

    # do we have a description parameter?
    # note we don''t use zparseopts here because of combined option parameters
    # with arguments like -default- confuse it.
    #
    # -d can be passed alone (from _arguments) or clustered (e.g. -ld from _describe), so match
    # any flag token of the form -<letters>d, not an exact "-d". Use (I) not (i): (i) returns
    # one-past-the-end on no match, making the presence test below always true. Restrict to the
    # leading flags-only prefix so a candidate that looks like a flag isn't mistaken for it.
    setopt localoptions extendedglob
    local -a __flags
    __flags=(${@[1,(i)(-|--)]})
    local __d_idx=${__flags[(I)-[a-zA-Z]#d]}
    if (( __d_idx )); then
        # next param after the flag containing -d
        __tmp=${@[$[__d_idx+1]]}
        # description can be given as an array parameter name, or inline () array
        if [[ $__tmp == \(* ]]; then
            eval "__dscr=$__tmp"
        else
            __dscr=( "${(@P)__tmp}" )
        fi
    fi

    # Capture completions by injecting -A parameter into the compadd call. This takes care of matching for us.
    builtin compadd -A __hits -D __dscr "$@"

    setopt localoptions norcexpandparam extendedglob

    # extract prefixes and suffixes from compadd call. we can''t do zsh''s cool
    # -r remove-func magic, but it''s better than nothing.
    typeset -A apre hpre hsuf asuf
    # Parse compadd options, based on the documentation.  Unused flags are left
    # in the array extra_args.  There are additional arguments we don't check
    # for here, but they all take arguments, so wouldn't interfere with parsing
    # of consolidated flags (e.g.: -Qf being parsed as -Q and -f).
    zparseopts -E -a extra_args - f=dirsuf P:=apre p:=hpre S:=asuf s:=hsuf a k q Q e n U l 1 2 C

    # Change dirsuf to store whether or not the -f flag was provided.
    integer dirsuf=${#dirsuf}

    # just drop
    [[ -n $__hits ]] || return

    # this is the point where we have all matches in $__hits and all
    # descriptions in $__dscr!

    # $PREFIX is the part of the current word these matches replace, except when the completion
    # function reported part of it as a display-only hint via `-p`/`-P` (parsed into $hpre/$apre).
    # `_path_files` does this for a multi-component path: it sets $PREFIX to the whole remaining
    # path (`/et` for `cd /et`) but the matches are bare basenames (`etc`), so the real replaced
    # text is $PREFIX minus that hint prefix (`et`). Reporting the whole $PREFIX would name a span
    # no candidate starts with, which the client filters out -- Tab silently doing nothing.
    local __hint_prefix="${(v)apre}${(v)hpre}"
    local __replaced_prefix="$PREFIX"
    if [[ -n $__hint_prefix && $PREFIX == "${__hint_prefix}"* ]]; then
        __replaced_prefix="${PREFIX#$__hint_prefix}"
    fi

    # Native completions only complete up to the cursor, so there's no $SUFFIX and
    # $__replaced_prefix is a trailing substring of the line, in the exact characters typed: its
    # start is the line length minus its own.
    #
    # The wire format is byte offsets, but zsh's `${#...}` counts characters, not bytes, once the
    # line has non-ASCII text (the same class of bug as PowerShell's UTF-16 offsets). `LC_ALL=C`
    # makes it count bytes; nothing later in this function counts characters, so scoping it here is
    # fine.
    local LC_ALL=C
    local __span_start=$(( ${#_ROOK_NATIVE_COMPLETIONS_LINE} - ${#__replaced_prefix} ))
    local __span_len=${#__replaced_prefix}
    rook_mark_replacement_span_for_compadd_override $__span_start $__span_len

    # display all matches
    #
    # $asuf (compadd's -S) is inserted after every match -- e.g. `_arguments` passes -S '=' for
    # `--color=` so the option and value join. $hsuf (-s) is its display-only counterpart, so
    # only $asuf belongs in the inserted text. Without it, `--color` for `ls --col` loses its `=`.
    local asuf_str="${(v)asuf}"
    local dsuf dscr
    local __rook_hex_match __rook_hex_dscr
    for i in {1..$#__hits}; do
        # Add a dir suffix? Test the real path, not the bare basename: $__hits[$i] is a basename
        # only when $__hint_prefix is non-empty, so testing it alone resolves against $PWD and
        # gives a wrong `/` whenever $PWD differs. The `${~...}` flag forces tilde/glob expansion,
        # since a `~` from parameter substitution is otherwise left literal and the -d test would
        # fail for a `~`-relative directory.
        (( dirsuf )) && [[ -d ${~__hint_prefix}$__hits[$i] ]] && dsuf=/ || dsuf=
        # description to be displayed afterwards
        (( $#__dscr >= $i )) && dscr="${${__dscr[$i]}##$__hits[$i] #}" || dscr=""

        local match="$__hits[$i]$dsuf$asuf_str"

        # A capture-only compadd (-A/-D) never adds to zsh's real match list, so _main_complete
        # concludes every completer failed and runs the whole `completer` list, and _path_files
        # compadds once per tag -- both re-emit identical rows. Dedup per request on the full
        # emitted identity (replacement span + inserted text + description) so identical rows
        # collapse, while a same-name/different-description pair survives (keying on the name alone
        # would drop the latter -- the silent loss a dedup must avoid).
        local __dedup_key="${__span_start},${__span_len}"$'\x1f'"${match}"$'\x1f'"${dscr}"
        if (( ${+_ROOK_SEEN_COMPLETIONS[$__dedup_key]} )); then
            continue
        fi
        _ROOK_SEEN_COMPLETIONS[$__dedup_key]=1

        rook_completions_hex_encode_into __rook_hex_match "$match"
        print -n "\e]9280;C"$OSC_PARAM_SEPARATOR$__rook_hex_match$OSC_END
        if [[ -n "$dscr" ]]; then
            rook_completions_hex_encode_into __rook_hex_dscr "$dscr"
            print -n "\e]9280;D?description"$OSC_PARAM_SEPARATOR$__rook_hex_dscr$OSC_END
        fi
    done
  }

  # Marks the start of completions generation using a custom OSC.
  function rook_mark_start_of_completions () {
    printf '\e]9280;A\a'
  }

  function rook_mark_start_of_completions_for_compadd_override () {
    rook_mark_start_of_completions
    # Start of a completion request: reset the per-request dedup set consulted in the compadd
    # override, so candidates are only deduped within a single request.
    typeset -gA _ROOK_SEEN_COMPLETIONS
    _ROOK_SEEN_COMPLETIONS=()
  }

  # Reports the byte-offset range of the line that the matches replace.
  function rook_mark_replacement_span_for_compadd_override () {
    printf '\e]9280;S;%s,%s\a' $1 $2
  }

  # Marks the end of completions generation using a custom OSC.
  function rook_mark_end_of_completions () {
    printf '\e]9280;B\a'
  }

  # The main logic for generating completions.
  function rook_main_completer () {
    (( ${+functions[_generic]} )) || return 0
    # We want all the results listed.
    compstate[list_max]=-1

    # Delegate to `_generic` to kick off the completion pipeline. We call `_generic` instead of `_main_complete` to
    # ensure the proper completion context is set. Internally, `_generic` will call `_main_complete`.
    # We fake the number of columns to some large, arbitrary amount as a best-effort approach
    # to mitigate description truncation.
    COLUMNS=500 _generic
  }

  # Registers the custom completion widget and hooks it up to the main logic for completing.
  zle -C rook_complete_via_compadd_override_internal list-choices rook_main_completer

  # Avoid grouping, which can print options after the compostfunc hook runs.
  #
  # These zstyle patterns must match on 'zle-line-init', not the widget name: this completion is
  # driven from inside the zle-line-init hook, so $curcontext's leading component is always
  # literally "zle-line-init" regardless of the command being completed. The earlier widget-name
  # pattern matched nothing, silently suppressing descriptions for _describe-driven completions.
  zstyle ':completion:zle-line-init:*' list-grouped false
  zstyle ':completion:zle-line-init:*' insert-tab false
  zstyle ':completion:zle-line-init:*' verbose yes
  # Setting list-separator to an empty string avoids an extra `--` from being added
  # between the hit and the description.
  zstyle ':completion:zle-line-init:*' list-separator ''

  # Native shell completions: foreground generator.
  #
  # `select` is the only builtin that lets an ordinary (non-ZLE) command reach a real ZLE
  # completion context: a subshell, `$( )`, `( )`, a pipeline, or a backgrounded job all clear
  # `USEZLE` so the completion widgets never run. So the request must be a foreground command in
  # the main shell with no command substitution around the `select`, and cannot be cancelled by PID.
  #
  # `zle-line-init` fires once per `select` iteration. Plugins (p10k, zsh-syntax-highlighting,
  # zsh-autosuggestions) install their own via `add-zle-hook-widget`, which binds the *widget*
  # named `zle-line-init` to a differently-named function, so the capture below works entirely
  # through widget names (`zle -A`/`zle -N`/`$widgets`), not `functions[...]`.
  #
  # Our widget stays permanently bound to `zle-line-init` for the session rather than being torn
  # down per request: tearing down races chained hooks that rebind it, and leaving it bound
  # without a guard can alias it to itself and recurse. It always chains to whatever was bound
  # before, so it is transparent on ordinary prompt reads. The reentrancy guard below makes this
  # safe regardless of the order in which deferred plugin loaders rebind the hook.
  function _rook_native_completions_zle_line_init () {
    if (( _ROOK_NATIVE_COMPLETIONS_ZLE_LINE_INIT_RUNNING )); then
      return 0
    fi
    _ROOK_NATIVE_COMPLETIONS_ZLE_LINE_INIT_RUNNING=1
    {
      # zle-line-init can fire more than once while we own the widget
      if (( ! _ROOK_NATIVE_COMPLETIONS_ARMED )); then
        (( ${+widgets[_rook_saved_zle_line_init]} )) && zle _rook_saved_zle_line_init
        return 0
      fi
      _ROOK_NATIVE_COMPLETIONS_ARMED=0
      # Completion pre/post hooks may never run when the completion system is missing or fails.
      rook_mark_start_of_completions_for_compadd_override
      {
        BUFFER=$_ROOK_NATIVE_COMPLETIONS_LINE
        CURSOR=${#BUFFER}

        # Chain to whatever was bound to zle-line-init before we took it over, if anything.
        (( ${+widgets[_rook_saved_zle_line_init]} )) && zle _rook_saved_zle_line_init

        local -a compprefuncs=() comppostfuncs=()
        COMPADD_OVERRIDE=true
        zle rook_complete_via_compadd_override_internal
      } always {
        unset COMPADD_OVERRIDE
        rook_mark_end_of_completions

        # A single-space throwaway buffer (rather than an empty one) is what `select`
        # reliably accepts as ending its one read iteration without re-prompting.
        BUFFER=' '
        CURSOR=1
        zle accept-line
      }
    } always {
      _ROOK_NATIVE_COMPLETIONS_ZLE_LINE_INIT_RUNNING=0
    }
  }

  # Native shell completions generator command for zsh; the only argument is the hex-encoded
  # command line to complete. Emits the same OSC 9280 protocol as the compadd shim above. Unlike
  # `rook_run_generator_command`, this must run in the foreground in the main shell (never
  # backgrounded or in command substitution) so a `select` can reach a real ZLE completion
  # context, and so it cannot be cancelled by PID. See the "Native shell completions: foreground
  # generator" comment above `_rook_native_completions_zle_line_init`.
  rook_run_generator_command_native_completions() {
    _ROOK_GENERATOR_COMMAND=1
    _USER_PRECMD_FUNCTIONS=($precmd_functions)
    precmd_functions=(${(M)precmd_functions:#*(rook|p9k)*})

    local line=$(rook_hex_decode_string "$1")

    if [[ -z ${line//[[:space:]]/} ]] || ! { [[ -o zle ]] && [[ -o interactive ]] && [[ "$TERM" != emacs ]] }; then
      printf '\e]9280;A\a'
      printf '\e]9280;B\a'
      return
    fi

    _ROOK_NATIVE_COMPLETIONS_LINE=$line
    _ROOK_NATIVE_COMPLETIONS_ARMED=1

    # Take over zle-line-init for this select, saving whatever was bound to it under a private
    # widget name so it can be chained. Skip if it's already our own capture widget (left from a
    # prior request, since it is never torn down) -- there'd be nothing new to save.
    if [[ "${widgets[zle-line-init]:-}" != user:_rook_native_completions_zle_line_init ]]; then
      if (( ${+widgets[zle-line-init]} )); then
        zle -A zle-line-init _rook_saved_zle_line_init
      fi
      zle -N zle-line-init _rook_native_completions_zle_line_init
    fi

    local PS3='' REPLY
    # Swallow the line editor redraw the `select` causes with the same DCS bracketing
    # `rook_read_completion_buffer` uses above. A byte sequence starting with ESC ends DCS
    # passthrough, so this only swallows what precedes the first one.
    echo -n "${DCS_START}a"
    { select _ in 1; do break; done } 2>/dev/null
    echo -n "$DCS_END"

    # Fail safe: if the capture widget never ran (some other zle-line-init fired, or `select`
    # never entered ZLE), the armed flag would hijack the next real prompt read. Clear it and
    # answer with zero matches so the client always gets a response.
    if (( _ROOK_NATIVE_COMPLETIONS_ARMED )); then
      _ROOK_NATIVE_COMPLETIONS_ARMED=0
      printf '\e]9280;A\a'
      printf '\e]9280;B\a'
    fi
  }

  function rook_bootstrapped () {
    # Note that for now we don't support dynamically changing HISTFILE within a session.
    local escaped_histfile="$(rook_escape_json $HISTFILE)"

    # The output of `alias` can include control characters that need to be escaped.
    local escaped_aliases="$(rook_escape_json "`alias`")"
    local escaped_abbrs=""
    local env_var_names="$(rook_escape_json "`echo ${(k)parameters[(R)*export*]}`")"
    local function_names="$(rook_escape_json "`builtin print -l -- ${(ok)functions}`")"
    local escaped_builtins="$(rook_escape_json "`builtin print -l -- ${(ok)builtins}`")"
    local escaped_keywords="$(rook_escape_json "`builtin print -l -- ${(ok)reswords}`")"

    local escaped_path="$(rook_escape_json "$PATH")"

    local escaped_shell_plugins="$(rook_escape_json "`builtin print -l -- ${shell_plugins}`")"

    # The list of options enabled for the current shell.
    local shell_options="$(rook_escape_json "`setopt`")"

    local escaped_editor="$(rook_escape_json "$EDITOR")"
    local escaped_shell_path="$(rook_escape_json "${commands[zsh]}")"
    local escaped_cdpath="$(rook_escape_json "$CDPATH")"
    local escaped_json="{\"hook\": \"Bootstrapped\", \"value\": {\"histfile\": \"$escaped_histfile\", \"session_id\": $ROOK_SESSION_ID, \"shell\": \"zsh\", \"home_dir\": \"$HOME\", \"path\": \"$escaped_path\", \"cdpath\": \"$escaped_cdpath\", \"editor\": \"$escaped_editor\", \"env_var_names\":  \"$env_var_names\", \"abbreviations\": \"$escaped_abbrs\", \"aliases\": \"$escaped_aliases\", \"function_names\": \"$function_names\",  \"builtins\": \"$escaped_builtins\",  \"keywords\": \"$escaped_keywords\", \"shell_version\": \"$ZSH_VERSION\", \"shell_options\": \"$shell_options\", \"rcfiles_start_time\": \"$rcfiles_start_time\", \"rcfiles_end_time\": \"$rcfiles_end_time\", \"shell_plugins\": \"$escaped_shell_plugins\", \"os_category\": \"$os_category\", \"linux_distribution\": \"$linux_distribution\", \"wsl_name\": \"${WSL_DISTRO_NAME:-}\", \"shell_path\": \"$escaped_shell_path\"}}"
    rook_send_json_message "$escaped_json"
  }
  rook_bootstrapped
fi
