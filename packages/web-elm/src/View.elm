module View exposing (view)

import Browser
import Convo
import Data exposing (..)
import Dict
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Json.Decode as D
import Model exposing (..)
import Pages
import Phase exposing (Group(..), Phase(..))
import Ui exposing (..)


view : Model -> Browser.Document Msg
view model =
    let
        everything =
            { model | projectFilter = Nothing }

        forYou =
            List.length (inGroup everything NeedsYou)

        working =
            List.length (inGroup everything Running)
    in
    { title =
        (if forYou > 0 then
            "(" ++ String.fromInt forYou ++ ") "

         else
            ""
        )
            ++ (if working > 0 then
                    String.fromInt working ++ " working · "

                else
                    ""
               )
            ++ "cube"
    , body =
        [ div [ class "app" ]
            [ masthead model forYou working
            , banners model
            , main_ [ class "main" ]
                [ case model.route of
                    Now ->
                        floor model

                    Chat ->
                        Convo.chatPage model

                    ThreadPage id ->
                        Convo.threadPage model id

                    Artifacts ->
                        Pages.artifacts model

                    ArtifactPage _ ->
                        Pages.artifact model

                    Projects ->
                        Pages.projects model

                    Runners ->
                        Pages.runners model

                    History ->
                        Pages.history model

                    Settings ->
                        Pages.settings model

                    NotFound path ->
                        div [ class "page" ] [ h1 [] [ text "No page here" ], p [] [ text ("Nothing is at " ++ path ++ ". "), a [ href "#/" ] [ text "Back to the floor" ] ] ]
                ]
            ]
        , dialog model
        ]
    }


chatWords : Model -> ( String, String )
chatWords model =
    case model.chatGlance of
        Nothing ->
            ( "quiet", "not read yet" )

        Just glance ->
            case glance.status.state of
                Working ->
                    ( "working", "working" )

                Failed ->
                    ( "failed", "run failed" )

                Completed ->
                    ( "quiet", "turn ended" )

                Stopped ->
                    ( "quiet", "stopped" )

                Idle ->
                    ( "quiet", "idle" )


{-| One line across the top: where you are, the two counts that matter, and
whether what you see is current.
-}
masthead : Model -> Int -> Int -> Html Msg
masthead model forYou working =
    let
        item route fragment label =
            a [ href fragment, classList [ ( "current", sameSection route model.route ) ] ] [ text label ]
    in
    header [ class "masthead" ]
        [ a [ href "#/", class "wordmark" ] [ text "cube" ]
        , nav [ attribute "aria-label" "sections" ]
            [ item Now "#/" "floor"
            , item Chat "#/chat" "optchat"
            , item Artifacts "#/artifacts" "artifacts"
            , item Projects "#/projects" "projects"
            , item Runners "#/runners" "runners"
            , item History "#/history" "history"
            , item Settings "#/settings" "settings"
            ]
        , p [ class "tally", attribute "role" "status" ]
            [ a [ href "#/", classList [ ( "tally-foryou", forYou > 0 ) ] ] [ text (String.fromInt forYou ++ " for you") ]
            , span [ classList [ ( "tally-working", working > 0 ) ] ] [ text (String.fromInt working ++ " working") ]
            , case model.link of
                Connecting ->
                    span [] [ text "connecting" ]

                Live _ ->
                    span [ class "tally-live" ] [ text "live" ]

                Lost _ ->
                    span [ class "tally-lost" ] [ text "cubed unreachable" ]
            , button [ class "plain", onClick (Open Help), attribute "aria-label" "keyboard shortcuts" ] [ text "keys" ]
            ]
        ]


sameSection : Route -> Route -> Bool
sameSection section current =
    case ( section, current ) of
        ( Now, ThreadPage _ ) ->
            True

        ( Artifacts, ArtifactPage _ ) ->
            True

        _ ->
            section == current


banners : Model -> Html Msg
banners model =
    div [ class "banners" ]
        [ case model.health |> Maybe.andThen .preview of
            Just words ->
                p [ class "banner preview" ] [ text words ]

            Nothing ->
                text ""
        , case model.link of
            Lost lost ->
                p [ class "banner lost", attribute "role" "alert" ]
                    [ strong [] [ text "Can't reach cubed. " ]
                    , text
                        ("What you see is from "
                            ++ (lost.lastOk |> Maybe.map (ago model.now) |> Maybe.withDefault "before anything was read")
                            ++ " and may have changed. Trying again every 3 s. "
                            ++ lost.why
                        )
                    ]

            _ ->
                text ""
        , if model.activityRoute == Just False then
            p [ class "banner" ] [ text "This cubed reports run states only for threads optchat started. Other threads read “run not reported” until you open them." ]

          else
            text ""
        , case model.notice of
            Just ( bad, words ) ->
                p [ class "banner notice", classList [ ( "lost", bad ) ], attribute "role" "status" ]
                    [ text words, button [ class "plain", onClick DismissNotice ] [ text "dismiss" ] ]

            Nothing ->
                text ""
        ]


{-| The floor: on the left what is for you and the desk you give work
from; on the right every runner as a bay, each thread in the slot it holds.
-}
floor : Model -> Html Msg
floor model =
    let
        forYou =
            inGroup model NeedsYou

        ( chatClass, chatState ) =
            chatWords model

        chatLine =
            model.chatGlance
                |> Maybe.map
                    (\glance ->
                        Phase.activityLine
                            (if glance.status.state == Working then
                                Busy

                             else
                                Ended Phase.TurnEnded False
                            )
                            noThread
                            glance.events
                    )
                |> Maybe.withDefault ""

        draft =
            Dict.get "desk" model.drafts |> Maybe.withDefault ""

        ready =
            loaded model.projects |> List.filter (\p -> p.status == "ready")
    in
    div [ class "floor" ]
        [ section [ class "side", attribute "aria-label" "for you" ]
            [ div [ class "desk" ]
                [ h2 [] [ text "Give work" ]
                , textarea
                    [ id "desk"
                    , rows 3
                    , value draft
                    , onInput (DraftChanged "desk")
                    , onEnter DeskSend
                    , attribute "aria-label" "what should be done"
                    , placeholder
                        (if model.deskTarget == "optchat" then
                            "Tell optchat what you want done. It starts threads and reports back."

                         else
                            "The first message of a new thread."
                        )
                    ]
                    []
                , div [ class "desk-row" ]
                    [ label [ class "inline" ]
                        [ text "to "
                        , select [ onInput DeskTarget, id "desk-target" ]
                            (option [ value "optchat", selected (model.deskTarget == "optchat") ] [ text "optchat" ]
                                :: List.map (\p -> option [ value p.id, selected (model.deskTarget == p.id) ] [ text ("a new thread in " ++ p.name) ]) ready
                            )
                        ]
                    , button [ class "primary", onClick DeskSend, disabled (model.deskBusy || String.isEmpty (String.trim draft)) ]
                        [ text
                            (if model.deskBusy then
                                "sending"

                             else if model.deskTarget == "optchat" then
                                "send"

                             else
                                "start thread"
                            )
                        ]
                    ]
                , case model.deskError of
                    Just why ->
                        p [ class "problem", attribute "role" "alert" ] [ text ("Not sent: " ++ why ++ ". Your text is still here.") ]

                    Nothing ->
                        text ""
                , a [ href "#/chat", class "desk-chat" ]
                    [ span [ class ("state " ++ chatClass) ] [ text ("optchat " ++ chatState) ]
                    , span [ class "desk-line" ] [ text chatLine ]
                    ]
                ]
            , div [ class "tray" ]
                [ div [ class "tray-top" ]
                    [ h2 [] [ text ("For you · " ++ String.fromInt (List.length forYou)) ]
                    , if List.isEmpty forYou then
                        text ""

                      else
                        button [ class "plain", onClick MarkAllSeen ] [ text "mark all read" ]
                    ]
                , case model.threads of
                    Loading ->
                        p [ class "muted" ] [ text "Reading threads." ]

                    Unavailable why ->
                        p [ class "problem" ] [ text ("Threads could not be read: " ++ why) ]

                    Loaded _ ->
                        if List.isEmpty forYou then
                            p [ class "muted" ] [ text "Nothing waits on you. A thread lands here when its turn ends unread, its run fails or its machine fails." ]

                        else
                            div [] (List.map (trayItem model) forYou)
                ]
            ]
        , section [ class "bays", attribute "aria-label" "runners" ]
            [ div [ class "bays-top" ]
                [ h1 [] [ text "The floor" ]
                , label [ class "inline" ]
                    [ text "show "
                    , select [ onInput (\id -> SetProjectFilter (if id == "" then Nothing else Just id)), id "project-filter" ]
                        (option [ value "", selected (model.projectFilter == Nothing) ] [ text "all projects" ]
                            :: List.map (\p -> option [ value p.id, selected (model.projectFilter == Just p.id) ] [ text p.name ]) (loaded model.projects)
                        )
                    ]
                ]
            , remoteView model.runners "runners" <|
                \known ->
                    if List.isEmpty known.runners then
                        p [ class "muted" ] [ text "No runner is enrolled, so no thread can start. Enroll one with berth; it shows up here as a bay." ]

                    else
                        div [ class "bay-row" ] (List.map (bay model) known.runners ++ [ unplaced model known.runners ])
            ]
        ]


bay : Model -> Runner -> Html Msg
bay model item =
    let
        here =
            shownThreads model |> List.filter (\t -> t.runnerId == Just item.id)

        at place =
            List.filter (\t -> placeOf t == place) here

        down =
            item.contact == "unreachable"

        taken =
            item.slotsTotal - item.slotsFree

        others =
            Basics.max 0 (taken - List.length (at InSlot))
    in
    div [ classList [ ( "bay", True ), ( "down", down ) ], attribute "data-runner" item.nodeId ]
        [ div [ class "bay-head" ]
            [ h2 [] [ a [ href "#/runners" ] [ text item.nodeId ] ]
            , p []
                [ text
                    (case ( item.contact, item.unreachableSince ) of
                        ( "unreachable", Just since ) ->
                            "not answering for " ++ duration (model.now - since)

                        ( "unknown", _ ) ->
                            String.fromInt item.slotsFree ++ " of " ++ String.fromInt item.slotsTotal ++ " slots free · never probed"

                        _ ->
                            String.fromInt item.slotsFree ++ " of " ++ String.fromInt item.slotsTotal ++ " slots free"
                    )
                ]
            ]
        , if down then
            p [ class "bay-note" ] [ text "Its cards show what cubed last knew. Nothing here can move until it answers." ]

          else
            text ""
        , div [ class "slots" ]
            (List.map (card model) (at InSlot)
                ++ (if others > 0 && not down then
                        [ p [ class "slot other" ]
                            [ text
                                (String.fromInt others
                                    ++ (if model.projectFilter == Nothing then
                                            " more taken; cubed lists no open thread for them"

                                        else
                                            " more taken by other projects"
                                       )
                                )
                            ]
                        ]

                    else
                        []
                   )
                ++ (if down then
                        []

                    else
                        List.repeat item.slotsFree (p [ class "slot free" ] [ text "free slot" ])
                   )
            )
        , shelf "Waiting for a slot" (at InQueue) model
        , shelf "Suspended, holding no slot" (at Shelved) model
        ]


shelf : String -> List Thread -> Model -> Html Msg
shelf title_ items model =
    if List.isEmpty items then
        text ""

    else
        div [ class "shelf" ] (h3 [] [ text title_ ] :: List.map (card model) items)


{-| Threads whose runner is not in the list (or that have none yet).
-}
unplaced : Model -> List Runner -> Html Msg
unplaced model known =
    let
        lost =
            shownThreads model |> List.filter (\t -> not (List.any (\r -> Just r.id == t.runnerId) known))
    in
    if List.isEmpty lost then
        text ""

    else
        div [ class "bay" ] [ div [ class "bay-head" ] [ h2 [] [ text "No known runner" ], p [] [ text "cubed names no enrolled runner for these" ] ], div [ class "slots" ] (List.map (card model) lost) ]


noThread : Thread
noThread =
    { id = "", title = Nothing, name = Nothing, projectId = "", projectName = "", machine = MachineReady, error = Nothing, failureKind = Nothing, waiting = Nothing, createdAt = 0, archived = False, agent = "pi", model = Nothing, runnerId = Nothing, vmId = Nothing, steps = [], sleep = Nothing, notice = Nothing, retain = Nothing, retainReason = Nothing, discarded = False, startupMs = Nothing, prepared = Nothing }


dialog : Model -> Html Msg
dialog model =
    let
        shell title_ content =
            div [ class "overlay", onClick CloseDialog ]
                [ div [ class "dialog", attribute "role" "dialog", attribute "aria-modal" "true", attribute "aria-label" title_, stopPropagationOn "click" (D.succeed ( NoOp, True )) ]
                    (h2 [] [ text title_ ] :: content)
                ]

        problem error =
            case error of
                Just why ->
                    p [ class "problem", attribute "role" "alert" ] [ text why ]

                Nothing ->
                    text ""

        buttons label_ busy =
            div [ class "dialog-actions" ]
                [ button [ onClick CloseDialog ] [ text "cancel" ]
                , button [ class "primary", onClick SubmitDialog, disabled busy ]
                    [ text
                        (if busy then
                            "working"

                         else
                            label_
                        )
                    ]
                ]
    in
    case model.dialog of
        NoDialog ->
            text ""

        Help ->
            shell "Keys"
                [ table [ class "keys" ]
                    (List.map (\( key, what ) -> tr [] [ td [] [ kbd [] [ text key ] ], td [] [ text what ] ])
                        [ ( "g f", "the floor" ), ( "g c", "optchat" ), ( "g a", "artifacts" ), ( "g p", "projects" ), ( "g r", "runners" ), ( "g h", "history" ), ( "g s", "settings" ), ( "j / k", "next / previous card on the floor" ), ( "enter", "open the marked card" ), ( "n", "give work (the desk)" ), ( "c", "write in the open conversation" ), ( "/", "filter history" ), ( "esc", "close, leave the field, or back to the floor" ), ( "?", "this list" ) ]
                    )
                , div [ class "dialog-actions" ] [ button [ class "primary", onClick CloseDialog ] [ text "close" ] ]
                ]

        NewProject form ->
            shell "New project"
                [ label [] [ text "Name", input [ id "dialog-first", value form.name, onInput (DialogField "name") ] [] ]
                , label [] [ text "Repository url", input [ value form.url, onInput (DialogField "url"), placeholder "https://github.com/owner/name" ] [] ]
                , label [] [ text "Base branch (empty: the default branch)", input [ value form.base, onInput (DialogField "base") ] [] ]
                , p [ class "muted" ] [ text "cubed checks the repository when you save. Hooks and machine size cannot be edited in this preview." ]
                , problem form.error
                , buttons "save and check" form.busy
                ]

        Rename _ title_ ->
            shell "Rename thread"
                [ label [] [ text "Title", input [ id "dialog-first", value title_, onInput (DialogField "title"), onEnter SubmitDialog ] [] ]
                , buttons "rename" False
                ]

        Confirm spec ->
            shell spec.title
                [ p [] [ text spec.body ]
                , div [ class "dialog-actions" ]
                    [ button [ id "dialog-first", onClick CloseDialog ] [ text "cancel" ]
                    , button [ class "danger", onClick SubmitDialog ] [ text spec.label ]
                    ]
                ]

        RunAction form ->
            shell form.action.label
                [ p [] [ text (form.action.kind ++ " · " ++ form.action.repository ++ "#" ++ String.fromInt form.action.pull ++ " · " ++ form.action.method ++ " at "), code [] [ text (String.left 12 form.action.headSha) ] ]
                , case form.preview of
                    Nothing ->
                        p [ class "muted" ] [ text "Checking the pull request now." ]

                    Just (Err error) ->
                        p [ class "problem" ] [ text ("It could not be checked: " ++ error.message) ]

                    Just (Ok known) ->
                        div []
                            [ case known.pullTitle of
                                Just title_ ->
                                    p [] [ text ("Pull request: " ++ title_ ++ " (" ++ Maybe.withDefault "?" known.pullState ++ ")") ]

                                Nothing ->
                                    text ""
                            , if List.isEmpty known.problems then
                                label [] [ text ("Type " ++ known.confirm ++ " to confirm"), input [ id "dialog-first", value form.typed, onInput (DialogField "confirm") ] [] ]

                              else
                                ul [ class "problem" ] (List.map (\words -> li [] [ text words ]) known.problems)
                            ]
                , case form.result of
                    Just (Ok words) ->
                        p [ class "note", attribute "role" "status" ] [ text words ]

                    Just (Err error) ->
                        p [ class "problem", attribute "role" "alert" ] [ text ("It did not run: " ++ error.message) ]

                    Nothing ->
                        text ""
                , div [ class "dialog-actions" ]
                    [ button [ onClick CloseDialog ] [ text "close" ]
                    , button
                        [ class "danger"
                        , onClick SubmitDialog
                        , disabled
                            (form.busy
                                || (case form.preview of
                                        Just (Ok known) ->
                                            not (List.isEmpty known.problems) || form.typed /= known.confirm

                                        _ ->
                                            True
                                   )
                            )
                        ]
                        [ text "run it" ]
                    ]
                ]
