module Convo exposing (chatPage, threadPage)

{-| A conversation: OptChat's or a thread's. The transcript, what the agent
is doing right now, the composer, and for a thread where it runs.
-}

import Data exposing (..)
import Dict
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Html.Keyed as Keyed
import Json.Decode as D
import Json.Encode as E
import Model exposing (..)
import Phase exposing (Phase(..))
import Ui exposing (..)


type alias ToolStep =
    { key : String, name : String, input : Maybe E.Value, output : Maybe String, isError : Bool, done : Bool }


type Block
    = Said Event
    | Work String (List ToolStep)


{-| Tool calls and their results, joined by call id and gathered into runs
of work between the things said.
-}
blocks : List Event -> List Block
blocks events =
    let
        attach result steps =
            if List.any (\item -> item.key == result.callId) steps then
                List.map
                    (\item ->
                        if item.key == result.callId then
                            { item | output = Just result.output, isError = result.isError, done = result.final }

                        else
                            item
                    )
                    steps

            else
                steps ++ [ { key = result.callId, name = result.name, input = Nothing, output = Just result.output, isError = result.isError, done = result.final } ]

        add item acc =
            case ( item, acc ) of
                ( ToolCall call, (Work key steps) :: rest ) ->
                    Work key (steps ++ [ { key = call.callId, name = call.name, input = Just call.input, output = Nothing, isError = False, done = False } ]) :: rest

                ( ToolCall call, _ ) ->
                    Work call.id [ { key = call.callId, name = call.name, input = Just call.input, output = Nothing, isError = False, done = False } ] :: acc

                ( ToolResult result, (Work key steps) :: rest ) ->
                    Work key (attach result steps) :: rest

                ( ToolResult result, _ ) ->
                    Work result.id (attach result []) :: acc

                _ ->
                    Said item :: acc
    in
    List.foldl add [] events |> List.reverse


stepView : Bool -> ToolStep -> ( String, Html Msg )
stepView live item =
    let
        running =
            live && not item.done

        mark =
            if item.isError then
                span [ class "step-mark failed" ] []

            else if running then
                span [ class "step-mark running" ] []

            else if item.done then
                span [ class "step-mark done" ] []

            else
                span [ class "step-mark" ] []

        summary_ =
            item.input |> Maybe.map Phase.inputSummary |> Maybe.withDefault ""
    in
    ( item.key
    , details [ class "step", attribute "data-tool" item.name, classList [ ( "is-running", running ), ( "is-error", item.isError ) ] ]
        [ summary []
            [ mark
            , span [ class "step-name" ] [ text item.name ]
            , span [ class "step-input" ] [ text summary_ ]
            , if running then
                span [ class "step-live" ] [ text (item.output |> Maybe.map lastLine |> Maybe.withDefault "" |> (\line -> if String.isEmpty line then "running, no output yet" else line)) ]

              else
                text ""
            ]
        , case item.input of
            Just input ->
                pre [ class "step-io" ] [ text (E.encode 2 input) ]

            Nothing ->
                text ""
        , case item.output of
            Just output ->
                pre [ class "step-io", classList [ ( "failed", item.isError ) ] ] [ text output ]

            Nothing ->
                p [ class "muted" ] [ text "no result yet" ]
        ]
    )


lastLine : String -> String
lastLine output =
    String.lines (String.trim output) |> List.reverse |> List.head |> Maybe.withDefault "" |> String.left 160


blockView : Model -> Bool -> Block -> ( String, Html Msg )
blockView model live block =
    case block of
        Work key steps ->
            ( "work-" ++ key
            , div [ class "work", classList [ ( "live", live ) ] ]
                [ div [ class "work-head" ]
                    [ text
                        (String.fromInt (List.length steps)
                            ++ (if List.length steps == 1 then
                                    " step"

                                else
                                    " steps"
                               )
                            ++ (if live then
                                    " · in progress"

                                else
                                    ""
                               )
                        )
                    ]
                , Keyed.node "div" [] (List.map (stepView live) steps)
                ]
            )

        Said (UserMessage message) ->
            ( message.id
            , case message.from of
                Just from ->
                    let
                        full =
                            loaded model.threads |> List.filter (\item -> String.startsWith from item.id) |> List.head
                    in
                    div [ class "message report" ]
                        [ div [ class "message-head" ]
                            [ text "report from "
                            , case full of
                                Just item ->
                                    a [ href ("#/t/" ++ item.id) ] [ text (threadLabel item) ]

                                Nothing ->
                                    code [] [ text from ]
                            ]
                        , markdown message.text
                        ]

                Nothing ->
                    div [ class "message user", classList [ ( "pending", String.startsWith "pending." message.id ) ] ]
                        [ if String.startsWith "pending." message.id then
                            div [ class "message-head" ] [ text "accepted · the agent has not read it yet" ]

                          else
                            text ""
                        , div [ class "user-text" ] [ text message.text ]
                        ]
            )

        Said (AssistantText said) ->
            ( said.id
            , if said.reasoning then
                details [ class "message reasoning" ] [ summary [] [ text "thinking" ], markdown said.text ]

              else
                div [ class "message assistant", classList [ ("streaming", not said.final) ] ] [ markdown said.text ]
            )

        Said _ ->
            ( "", text "" )


transcriptView : Model -> Conv -> Maybe String -> Html Msg
transcriptView model conv notUp =
    let
        all =
            blocks conv.events

        working =
            Maybe.map .state conv.status == Just Working

        last =
            List.length all - 1
    in
    div [ id "transcript", class "transcript" ]
        [ if conv.start > 0 then
            button [ class "quiet-button older", onClick LoadOlder, disabled conv.loadingOlder ]
                [ text
                    (if conv.loadingOlder then
                        "reading…"

                     else
                        "show earlier (" ++ String.fromInt conv.start ++ " events before this)"
                    )
                ]

          else
            text ""
        , if not conv.loaded then
            case conv.stream of
                StreamEnded why ->
                    case notUp of
                        Just words ->
                            empty words

                        Nothing ->
                            p [ class "problem" ] [ text ("this conversation cannot be read: " ++ why) ]

                _ ->
                    p [ class "muted loading" ] [ text "reading the conversation…" ]

          else if List.isEmpty all then
            empty "nothing said yet."

          else
            Keyed.node "div" [ class "blocks" ] (List.indexedMap (\index block -> blockView model (working && index == last) block) all)
        ]


streamNote : Conv -> Html Msg
streamNote conv =
    case conv.stream of
        StreamOpen ->
            span [ class "stream live", title "frames arrive as the agent works" ] [ text "live" ]

        StreamOpening ->
            span [ class "stream" ] [ text "connecting…" ]

        StreamLost ->
            span [ class "stream lost", attribute "role" "status" ] [ text "live updates lost · retrying. what you see may be old" ]

        StreamEnded why ->
            span [ class "stream lost", attribute "role" "status" ] [ text ("live updates ended: " ++ why) ]


{-| `blocked`: nothing can be written. `hold`: a draft can be written but not sent yet.
-}
composer : Model -> Conv -> { blocked : Maybe String, hold : Maybe String, working : Bool, placeholder_ : String } -> Html Msg
composer model conv options =
    let
        draft =
            Dict.get conv.base model.drafts |> Maybe.withDefault ""
    in
    div [ class "composer" ]
        [ case conv.sendError of
            Just why ->
                p [ class "problem", attribute "role" "alert" ] [ text ("not sent: " ++ why ++ ". your text is still here.") ]

            Nothing ->
                text ""
        , case ( options.blocked, options.hold ) of
            ( Just why, _ ) ->
                p [ class "muted composer-blocked" ] [ text why ]

            ( Nothing, Just why ) ->
                p [ class "muted composer-blocked" ] [ text why ]

            _ ->
                text ""
        , div [ class "composer-row" ]
            [ textarea
                [ id "composer"
                , value draft
                , onInput (DraftChanged conv.base)
                , onEnter
                    (if options.hold == Nothing then
                        Send conv.base

                     else
                        NoOp
                    )
                , placeholder options.placeholder_
                , disabled (options.blocked /= Nothing)
                , rows 2
                , attribute "aria-label" "message"
                ]
                []
            , button [ class "primary", onClick (Send conv.base), disabled (options.blocked /= Nothing || options.hold /= Nothing || conv.sending || String.isEmpty (String.trim draft)) ]
                [ text
                    (if conv.sending then
                        "sending…"

                     else if options.working then
                        "send"

                     else
                        "send"
                    )
                ]
            ]
        , p [ class "hint" ] [ text "enter sends · shift+enter adds a line" ]
        ]


modelSelect : String -> Maybe Models -> Html Msg
modelSelect base known =
    case known of
        Just value ->
            select [ onInput (SetModel base), attribute "aria-label" "model" ]
                (List.map (\item -> option [ Html.Attributes.value (modelName item), selected (Just item == value.selected) ] [ text (modelName item) ]) value.models)

        Nothing ->
            text ""


chatPage : Model -> Html Msg
chatPage model =
    case model.conv of
        Nothing ->
            text ""

        Just conv ->
            let
                working =
                    Maybe.map .state conv.status == Just Working
            in
            div [ class "convo" ]
                [ header [ class "convo-head" ]
                    [ div []
                        [ h1 [] [ text "optchat" ]
                        , p [ class "muted" ] [ text "your one endless chat. it starts threads, tells them what to do and gets their reports." ]
                        ]
                    , div [ class "head-actions" ] [ modelSelect chatBase model.chatModels ]
                    ]
                , transcriptView model conv Nothing
                , div [ class "strip", classList [ ( "working", working ) ] ]
                    [ span [ class ("state " ++ runClass conv.status) ] [ text (runWords conv.status) ]
                    , span [ class "strip-doing" ] [ text (runDoing conv) ]
                    , streamNote conv
                    , if working then
                        button [ class "danger", onClick (Stop conv.base) ] [ text "stop" ]

                      else
                        text ""
                    ]
                , composer model conv { blocked = Nothing, hold = Nothing, working = False, placeholder_ = "Tell optchat what you want done" }
                ]


runWords : Maybe RunStatus -> String
runWords status =
    case Maybe.map .state status of
        Just Working ->
            "working"

        Just Completed ->
            "turn ended"

        Just Failed ->
            "run failed"

        Just Stopped ->
            "stopped"

        Just Idle ->
            "idle"

        Nothing ->
            "…"


runClass : Maybe RunStatus -> String
runClass status =
    case Maybe.map .state status of
        Just Working ->
            "working"

        Just Failed ->
            "failed"

        _ ->
            "quiet"


runDoing : Conv -> String
runDoing conv =
    case conv.status of
        Just status ->
            case status.state of
                Working ->
                    Phase.activityLine Busy placeholderThread (List.drop (List.length conv.events - 4) conv.events)

                Failed ->
                    Maybe.withDefault "" status.error

                _ ->
                    ""

        Nothing ->
            ""


placeholderThread : Thread
placeholderThread =
    { id = "", title = Nothing, name = Nothing, projectId = "", projectName = "", machine = MachineReady, error = Nothing, failureKind = Nothing, waiting = Nothing, createdAt = 0, archived = False, agent = "pi", model = Nothing, runnerId = Nothing, vmId = Nothing, steps = [], sleep = Nothing, notice = Nothing, retain = Nothing, retainReason = Nothing, discarded = False, startupMs = Nothing, prepared = Nothing }


threadPage : Model -> String -> Html Msg
threadPage model id =
    case ( model.conv, loaded model.threads |> List.filter (\item -> item.id == id) |> List.head ) of
        ( Just conv, Just item ) ->
            let
                value =
                    phaseOf model item

                working =
                    value == Busy

                blocked =
                    case value of
                        MachineFailed _ ->
                            Just "its machine failed, so no message can reach the agent. the panel shows the failed step."

                        Starting ->
                            Just "its machine is starting. a message now would wait unseen, so the composer opens when it is up."

                        WaitingSlot why ->
                            Just ("it waits for a free slot (" ++ why ++ "). the composer opens when its machine is up.")

                        WakingUp ->
                            Just "its machine is waking. the composer opens when it is up."

                        _ ->
                            Nothing
            in
            div [ class "convo with-panel", classList [ ( "panel-open", conv.panel ) ] ]
                [ header [ class "convo-head" ]
                    [ div []
                        [ h1 [] [ text (threadLabel item) ]
                        , p [ class "muted where" ]
                            [ span [ class "tag" ] [ text item.projectName ]
                            , text (" on " ++ runnerName model item ++ " · " ++ item.agent ++ " · ")
                            , text (Maybe.withDefault "" item.name ++ " ")
                            , code [] [ text (shortId item.id) ]
                            ]
                        ]
                    , div [ class "head-actions" ]
                        [ button [ class "quiet-button panel-toggle", onClick TogglePanel ]
                            [ text
                                (if conv.panel then
                                    "hide machine"

                                 else
                                    "machine"
                                )
                            ]
                        , button [ class "quiet-button", onClick (Open (Rename item.id (Maybe.withDefault "" item.title))) ] [ text "rename" ]
                        , button
                            [ class "quiet-button"
                            , onClick
                                (Open
                                    (Confirm
                                        { title = "archive this thread?"
                                        , body = "its agent closes and its machine is released. the disk is deleted only when nothing is uncommitted and every commit is pushed; otherwise cube keeps it and says why. a working thread is refused, never stopped."
                                        , label = "archive"
                                        , run = Do "archive" (send "DELETE" (threadBase item.id) (E.object []) (D.succeed ()) (DidGo "thread archived" "#/"))
                                        }
                                    )
                                )
                            ]
                            [ text "archive" ]
                        ]
                    ]
                , transcriptView model
                    conv
                    (if Phase.group value == Phase.GettingReady then
                        Just "its conversation opens here when its machine is up. cubed does not serve it before."

                     else
                        Nothing
                    )
                , div [ class ("strip " ++ stateClass value) ]
                    [ stateWord value
                    , span [ class "strip-doing" ] [ text (Phase.activityLine value item (List.drop (List.length conv.events - 4) conv.events)) ]
                    , case elapsed model item value of
                        Just ( time, why ) ->
                            span [ class "elapsed", title why ] [ text time ]

                        Nothing ->
                            text ""
                    , if Phase.group value == Phase.GettingReady then
                        text ""

                      else
                        streamNote conv
                    , if working then
                        button [ class "danger", onClick (Stop conv.base) ] [ text "stop" ]

                      else
                        text ""
                    ]
                , composer model
                    conv
                    { blocked = blocked
                    , hold =
                        if working then
                            Just "it is working, and cubed takes your message to a thread only between runs. write it now and send when the turn ends, stop the run, or ask optchat to tell it (optchat's messages are steered in)."

                        else
                            Nothing
                    , working = working
                    , placeholder_ =
                        case value of
                            Busy ->
                                "Write ahead: you can send it when the run has ended"

                            Asleep ->
                                "A message wakes its machine"

                            _ ->
                                "Message this thread"
                    }
                , panel model conv item value
                ]

        ( _, Nothing ) ->
            div [ class "page" ]
                [ case model.threads of
                    Loading ->
                        p [ class "muted loading" ] [ text "reading the thread…" ]

                    _ ->
                        div []
                            [ h1 [] [ text "no such open thread" ]
                            , p [] [ text "it may be archived. archived threads are listed in ", a [ href "#/history" ] [ text "history" ], text "." ]
                            ]
                ]

        _ ->
            text ""


panel : Model -> Conv -> Thread -> Phase -> Html Msg
panel model conv item value =
    let
        steps =
            Maybe.withDefault item.steps conv.steps

        fact name content =
            div [ class "fact" ] [ span [ class "fact-name" ] [ text name ], span [ class "fact-value" ] content ]
    in
    aside [ class "panel", attribute "aria-label" "where this thread runs" ]
        [ h2 [] [ text "where it runs" ]
        , fact "runner" [ a [ href "#/runners" ] [ text (runnerName model item) ] ]
        , fact "machine" [ code [] [ text (Maybe.withDefault "none yet" item.vmId) ] ]
        , fact "state" [ stateWord value ]
        , case item.sleep of
            Just (Suspended at) ->
                fact "sleep" [ text ("suspended " ++ ago model.now at ++ "; holds no slot") ]

            _ ->
                text ""
        , fact "agent" [ text item.agent ]
        , fact "model" [ modelSelect conv.base conv.models ]
        , fact "prepared" [ text (Maybe.withDefault "unknown" item.prepared ++ (item.startupMs |> Maybe.map (\ms -> " · ready in " ++ duration ms) |> Maybe.withDefault "")) ]
        , case item.notice of
            Just words ->
                p [ class "note" ] [ text words ]

            Nothing ->
                text ""
        , h2 [] [ text "startup" ]
        , if List.isEmpty steps then
            empty "no startup steps recorded."

          else
            ol [ class "steps" ]
                (List.map
                    (\one ->
                        li [ class ("startup-step " ++ one.state) ]
                            [ span [ class "step-state" ] [ text one.state ]
                            , span [] [ text (one.name ++ (one.attempt |> Maybe.map (\n -> " · try " ++ String.fromInt n) |> Maybe.withDefault "")) ]
                            , span [ class "muted" ] [ text (duration (Maybe.withDefault model.now one.endedAt - one.startedAt)) ]
                            , case one.detail of
                                Just detail ->
                                    div [ class "muted step-detail" ] [ text detail ]

                                Nothing ->
                                    text ""
                            , case one.log of
                                Just log ->
                                    pre [ class "step-io failed" ] [ text log ]

                                Nothing ->
                                    text ""
                            ]
                    )
                    steps
                )
        , h2 [] [ text "services" ]
        , case conv.services of
            Nothing ->
                p [ class "muted" ] [ text "reading…" ]

            Just (Err error) ->
                p [ class "problem" ] [ text error.message ]

            Just (Ok known) ->
                if List.isEmpty known.services then
                    empty
                        (if known.running then
                            "no service runs in this machine. portal: " ++ known.portal ++ "."

                         else
                            "the machine is not running, so its services are not listed."
                        )

                else
                    ul []
                        (List.map
                            (\service ->
                                li []
                                    [ case service.url of
                                        Just url ->
                                            a [ href url, target "_blank", rel "noreferrer" ] [ text service.name ]

                                        Nothing ->
                                            text service.name
                                    , span [ class "muted" ] [ text (" · port " ++ String.fromInt service.portNumber ++ (service.state |> Maybe.map (\s -> " · " ++ s) |> Maybe.withDefault "")) ]
                                    ]
                            )
                            known.services
                        )
        , h2 [] [ text "usage" ]
        , case conv.usage of
            Just spent ->
                p [] [ text (String.fromInt spent.tokens ++ " tokens" ++ (spent.usd |> Maybe.map (\usd -> " · about $" ++ String.fromFloat (toFloat (round (usd * 100)) / 100)) |> Maybe.withDefault "")) ]

            Nothing ->
                p [ class "muted" ] [ text "not read yet" ]
        , p [] [ a [ href (threadBase item.id ++ "/diagnostics"), target "_blank", rel "noreferrer" ] [ text "machine diagnostics (json)" ] ]
        ]
