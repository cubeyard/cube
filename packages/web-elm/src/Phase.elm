module Phase exposing (End(..), Group(..), Phase(..), activityLine, group, groupLabel, inputSummary, label, phase, runFromWords, runKey)

{-| The one answer to "what is this thread doing, and does it need me":
its machine's condition and its run's state, ranked once, here.
-}

import Data exposing (Event(..), Machine(..), RunState(..), RunStatus, Thread)
import Json.Decode as D


type End
    = TurnEnded
    | RunFailed String
    | RunStopped


type Phase
    = MachineFailed String
      -- The Bool: this browser has not shown the run's end yet.
    | Ended End Bool
    | Busy
    | Background (List String)
    | Starting
    | WaitingSlot String
    | WakingUp
    | Asleep
    | NeverRan
      -- Its machine is ready; nothing readable says whether a run goes on.
    | Unreported


type Group
    = NeedsYou
    | Running
    | GettingReady
    | Quiet


{-| What identifies a run's end, for "have I seen it".
-}
runKey : RunStatus -> String
runKey status =
    Maybe.withDefault "" status.run
        ++ (case status.state of
                Completed ->
                    ":completed"

                Failed ->
                    ":failed"

                Stopped ->
                    ":stopped"

                _ ->
                    ""
           )


phase : { seen : Maybe String, run : Maybe RunStatus, agentOpen : Bool } -> Thread -> Phase
phase known thread =
    let
        unread status =
            known.seen /= Just (runKey status)

        ofRun =
            case known.run of
                Nothing ->
                    Unreported

                Just status ->
                    case status.state of
                        Data.Working ->
                            Busy

                        Idle ->
                            NeverRan

                        Completed ->
                            if not (List.isEmpty status.waiting) && known.agentOpen then
                                Background status.waiting

                            else
                                Ended TurnEnded (unread status)

                        Failed ->
                            Ended (RunFailed (Maybe.withDefault "the run failed" status.error)) (unread status)

                        Stopped ->
                            Ended RunStopped False
    in
    case ( thread.machine, thread.sleep ) of
        ( MachineError, _ ) ->
            MachineFailed (Maybe.withDefault "the thread's machine failed" thread.error)

        ( _, Just (Data.Queued why _) ) ->
            WaitingSlot why

        ( _, Just (Data.Waking (Just why)) ) ->
            WaitingSlot why

        ( _, Just (Data.Waking Nothing) ) ->
            WakingUp

        ( MachineStarting, _ ) ->
            case thread.waiting of
                Just why ->
                    WaitingSlot why

                Nothing ->
                    Starting

        ( MachineReady, Just (Data.Suspended _) ) ->
            case ofRun of
                Ended end True ->
                    Ended end True

                _ ->
                    Asleep

        ( MachineReady, Nothing ) ->
            ofRun


group : Phase -> Group
group value =
    case value of
        MachineFailed _ ->
            NeedsYou

        Ended RunStopped _ ->
            Quiet

        Ended _ True ->
            NeedsYou

        Ended _ False ->
            Quiet

        Busy ->
            Running

        Background _ ->
            Running

        Starting ->
            GettingReady

        WaitingSlot _ ->
            GettingReady

        WakingUp ->
            GettingReady

        Asleep ->
            Quiet

        NeverRan ->
            Quiet

        Unreported ->
            Quiet


groupLabel : Group -> String
groupLabel value =
    case value of
        NeedsYou ->
            "needs you"

        Running ->
            "working"

        GettingReady ->
            "getting ready"

        Quiet ->
            "quiet"


label : Phase -> String
label value =
    case value of
        MachineFailed _ ->
            "machine failed"

        Ended TurnEnded True ->
            "turn ended · unread"

        Ended TurnEnded False ->
            "turn ended"

        Ended (RunFailed _) _ ->
            "run failed"

        Ended RunStopped _ ->
            "stopped"

        Busy ->
            "working"

        Background _ ->
            "background work"

        Starting ->
            "starting machine"

        WaitingSlot _ ->
            "waiting for a slot"

        WakingUp ->
            "waking machine"

        Asleep ->
            "suspended"

        NeverRan ->
            "ready · never ran"

        Unreported ->
            "ready · run not reported"


{-| The run states cubed prints for OptChat's threads, as a run.
-}
runFromWords : String -> Maybe RunStatus
runFromWords words =
    let
        run state =
            Just { state = state, run = Nothing, error = Nothing, waiting = [] }
    in
    case words of
        "working" ->
            run Data.Working

        "completed" ->
            run Completed

        "failed" ->
            run Failed

        "stopped" ->
            run Stopped

        "not started" ->
            run Idle

        "waiting on a background agent" ->
            Just { state = Completed, run = Nothing, error = Nothing, waiting = [ "a background agent" ] }

        _ ->
            Nothing


lines : String -> List String
lines text =
    String.lines (String.trim text) |> List.filter (String.trim >> String.isEmpty >> not)


firstLine : String -> String
firstLine text =
    lines text |> List.head |> Maybe.withDefault "" |> plain |> String.left 220


{-| A line of markdown without its marks, for a one-line summary.
-}
plain : String -> String
plain line =
    line |> String.replace "**" "" |> String.replace "`" "" |> dropWhile (\c -> c == '#' || c == ' ' || c == '>')


dropWhile : (Char -> Bool) -> String -> String
dropWhile drop text =
    case String.uncons text of
        Just ( first, rest ) ->
            if drop first then
                dropWhile drop rest

            else
                text

        Nothing ->
            text


lastLine : String -> String
lastLine text =
    lines text |> List.reverse |> List.head |> Maybe.withDefault "" |> String.left 220


{-| A tool call's input in a few words: the command, the path, the task.
-}
inputSummary : D.Value -> String
inputSummary input =
    let
        field name =
            D.decodeValue (D.field name D.string) input |> Result.toMaybe

        firstTask =
            D.decodeValue (D.field "tasks" (D.index 0 (D.field "task" D.string))) input |> Result.toMaybe
    in
    [ field "command", field "file_path", field "path", field "pattern", field "query", field "title", field "message", field "id", firstTask ]
        |> List.filterMap identity
        |> List.head
        |> Maybe.map firstLine
        |> Maybe.withDefault ""


{-| What the newest events say the thread is doing or last said.
-}
activityLine : Phase -> Thread -> List Event -> String
activityLine value thread events =
    let
        newest =
            List.reverse events

        lastSaid =
            newest
                |> List.filterMap
                    (\item ->
                        case item of
                            AssistantText said ->
                                if said.reasoning then
                                    Nothing

                                else
                                    Just (firstLine said.text)

                            _ ->
                                Nothing
                    )
                |> List.head
                |> Maybe.withDefault ""

        doing =
            case newest of
                (ToolCall call) :: _ ->
                    call.name ++ " · " ++ inputSummary call.input

                (ToolResult result) :: rest ->
                    if result.final then
                        "read the result of " ++ result.name ++ " · thinking"

                    else
                        result.name
                            ++ " · "
                            ++ (case rest of
                                    (ToolCall call) :: _ ->
                                        inputSummary call.input ++ " → "

                                    _ ->
                                        ""
                               )
                            ++ lastLine result.output

                (AssistantText said) :: _ ->
                    if said.final then
                        "thinking"

                    else if said.reasoning then
                        "thinking · " ++ lastLine said.text

                    else
                        "writing · " ++ lastLine said.text

                (UserMessage _) :: _ ->
                    "read your message · thinking"

                [] ->
                    "working"

        runningStep =
            thread.steps |> List.filter (\item -> item.state == "running") |> List.reverse |> List.head
    in
    case value of
        MachineFailed why ->
            why

        Ended (RunFailed why) _ ->
            why

        Ended _ _ ->
            lastSaid

        Busy ->
            doing

        Background names ->
            "left running: " ++ String.join ", " names

        Starting ->
            case runningStep of
                Just item ->
                    "step: " ++ item.name ++ (Maybe.map (\detail -> " · " ++ detail) item.detail |> Maybe.withDefault "")

                Nothing ->
                    "the machine is booting"

        WaitingSlot why ->
            why

        WakingUp ->
            "resuming from its saved state"

        Asleep ->
            if String.isEmpty lastSaid then
                "idle; its machine holds no slot. a message wakes it"

            else
                lastSaid

        NeverRan ->
            "no message sent yet"

        Unreported ->
            "open it to read its run"
