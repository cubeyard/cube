module Model exposing (..)

import Browser
import Browser.Events exposing (Visibility)
import Browser.Navigation as Nav
import Data exposing (..)
import Dict exposing (Dict)
import Json.Decode as D
import Phase exposing (Phase)
import Set exposing (Set)
import Time
import Url exposing (Url)


type Route
    = Now
    | Chat
    | ThreadPage String
    | Artifacts
    | ArtifactPage String
    | Projects
    | Runners
    | History
    | Settings
    | NotFound String


{-| What was read from cubed: the last good value stays while a later read
fails, and `Link` says the reads fail.
-}
type Remote a
    = Loading
    | Loaded a
    | Unavailable String


{-| Whether this window's reads reach cubed.
-}
type Link
    = Connecting
    | Live Int
    | Lost { since : Int, lastOk : Maybe Int, why : String }


type Stream
    = StreamOpening
    | StreamOpen
    | StreamLost
    | StreamEnded String


{-| The open conversation: OptChat's or a thread's. `base` is its API prefix.
-}
type alias Conv =
    { base : String
    , start : Int
    , events : List Event
    , status : Maybe RunStatus
    , stream : Stream
    , loaded : Bool
    , sending : Bool
    , sendError : Maybe String
    , loadingOlder : Bool
    , expanded : Set String
    , models : Maybe Models
    , steps : Maybe (List Step)
    , services : Maybe (Api Services)
    , usage : Maybe Spend
    , panel : Bool
    }


type alias ProjectForm =
    { name : String, url : String, base : String, busy : Bool, error : Maybe String }


type alias ActionForm =
    { action : Action, preview : Maybe (Api Preview), typed : String, busy : Bool, result : Maybe (Api String) }


type Dialog
    = NoDialog
    | NewProject ProjectForm
    | Confirm { title : String, body : String, label : String, run : Msg }
    | Rename String String
    | RunAction ActionForm
    | Help


type alias ArtifactState =
    { id : String
    , view : Remote ArtifactView
    , shown : Maybe Int
    , revision : Remote Revision
    , selection : Maybe Anchor
    , body : String
    , busy : Bool
    }


type alias SettingsData =
    { providers : Remote (List Provider)
    , github : Remote Github
    , update : Remote Update
    , usage : Remote UsageReport
    , chatView : Remote ChatView
    , settings : Remote SettingsView
    , skills : Remote (List String)
    , memoryOpen : Bool
    }


type alias Model =
    { key : Nav.Key
    , route : Route
    , now : Int
    , visible : Bool
    , link : Link
    , threads : Remote (List Thread)
    , archived : Remote (List Thread)
    , activity : Dict String Activity

    -- Nothing: not asked yet. False: this cubed has no /api/activity.
    , activityRoute : Maybe Bool
    , overview : Dict String String
    , chatGlance : Maybe Transcript
    , projects : Remote (List Project)
    , runners : Remote RunnerPool
    , artifacts : Remote (List ArtifactItem)
    , health : Maybe Health
    , models : Maybe Models
    , chatModels : Maybe Models
    , seen : Dict String String

    -- When this window first saw each thread's current run working.
    , since : Dict String ( String, Int )
    , projectFilter : Maybe String
    , search : String
    , conv : Maybe Conv
    , drafts : Dict String String
    , artifact : Maybe ArtifactState
    , settings : SettingsData
    , dialog : Dialog
    , notice : Maybe ( Bool, String )
    , cursor : Int
    , goPending : Bool
    , counter : Int

    -- The floor's desk: where a message goes ("optchat" or a project id).
    , deskTarget : String
    , deskBusy : Bool
    , deskError : Maybe String
    }


type alias Key =
    { key : String, tag : String, modified : Bool }


type Msg
    = UrlChanged Url
    | LinkClicked Browser.UrlRequest
    | Tick Time.Posix
    | Poll
    | SlowPoll
    | VisibilityChanged Visibility
    | GotThreads (Api (List Thread))
    | GotArchived (Api (List Thread))
    | GotActivity (Api (Dict String Activity))
    | GotOverview (Api (Dict String String))
    | GotChatGlance (Api Transcript)
    | GotProjects (Api (List Project))
    | GotRunners (Api RunnerPool)
    | GotArtifacts (Api (List ArtifactItem))
    | GotHealth (Api Health)
    | GotModels (Api Models)
    | GotChatModels (Api Models)
    | StreamFrame D.Value
    | StreamState D.Value
    | LoadOlder
    | GotOlder String (Api Page)
    | DraftChanged String String
    | Send String
    | Sent String (Api ())
    | Stop String
    | Toggle String
    | TogglePanel
    | GotThreadModels String (Api Models)
    | SetModel String String
    | GotSteps String (Api (List Step))
    | GotServices String (Api Services)
    | GotUsage String (Api Spend)
    | SeenChanged D.Value
    | MarkAllSeen
    | SetProjectFilter (Maybe String)
    | SetSearch String
    | DeskTarget String
    | DeskSend
    | DeskSent (Api ())
    | Pressed Key
    | Open Dialog
    | CloseDialog
    | DialogField String String
    | SubmitDialog
    | Created (Api String)
    | ProjectSaved (Api Project)
    | Do String (Cmd Msg)
    | Did String (Api ())
    | DidGo String String (Api ())
    | GotArtifact String (Api ArtifactView)
    | GotRevision String (Api Revision)
    | ShowRevision Int
    | SelectionMade D.Value
    | CommentBody String
    | AddComment
    | CommentSaved (Api ())
    | GotPreview (Api Preview)
    | ActionRan (Api String)
    | GotProviders (Api (List Provider))
    | GotGithub (Api Github)
    | GotUpdate (Api Update)
    | GotUsageReport (Api UsageReport)
    | GotChatView (Api ChatView)
    | GotSettings (Api SettingsView)
    | GotSkills (Api (List String))
    | ToggleMemory
    | DismissNotice
    | NoOp


chatBase : String
chatBase =
    "/api/optchat"


threadBase : String -> String
threadBase id =
    "/api/threads/" ++ Url.percentEncode id


loaded : Remote (List a) -> List a
loaded remote =
    case remote of
        Loaded items ->
            items

        _ ->
            []


{-| The thread's run as far as this window knows it: the open conversation's
stream first, then `/api/activity`, then OptChat's own words for it.
-}
runOf : Model -> Thread -> { run : Maybe RunStatus, events : List Event, agentOpen : Bool }
runOf model thread =
    let
        fromStream =
            model.conv
                |> Maybe.andThen
                    (\conv ->
                        if conv.base == threadBase thread.id && conv.loaded then
                            conv.status |> Maybe.map (\status -> { run = Just status, events = conv.events, agentOpen = True })

                        else
                            Nothing
                    )
    in
    case fromStream of
        Just known ->
            known

        Nothing ->
            case Dict.get thread.id model.activity of
                Just item ->
                    { run =
                        case ( item.status, item.error ) of
                            ( Nothing, Nothing ) ->
                                Just { state = Idle, run = Nothing, error = Nothing, waiting = [] }

                            _ ->
                                item.status
                    , events = item.events
                    , agentOpen = item.agentOpen
                    }

                Nothing ->
                    { run = Dict.get thread.id model.overview |> Maybe.andThen Phase.runFromWords, events = [], agentOpen = True }


phaseOf : Model -> Thread -> Phase
phaseOf model thread =
    let
        known =
            runOf model thread
    in
    Phase.phase { seen = Dict.get thread.id model.seen, run = known.run, agentOpen = known.agentOpen } thread


{-| The open threads the project filter lets through, newest first.
-}
shownThreads : Model -> List Thread
shownThreads model =
    loaded model.threads
        |> List.filter (\thread -> not thread.archived && (model.projectFilter == Nothing || model.projectFilter == Just thread.projectId))
        |> List.sortBy (\thread -> negate thread.createdAt)


inGroup : Model -> Phase.Group -> List Thread
inGroup model wanted =
    shownThreads model |> List.filter (\thread -> Phase.group (phaseOf model thread) == wanted)


{-| Where a thread sits on the floor: in one of its runner's slots, in the
runner's queue, or shelved (suspended: it holds no slot).
-}
type Place
    = InSlot
    | InQueue
    | Shelved


placeOf : Thread -> Place
placeOf item =
    case item.sleep of
        Just (Suspended _) ->
            Shelved

        Just (Queued _ _) ->
            InQueue

        Just (Waking (Just _)) ->
            InQueue

        _ ->
            if item.machine == MachineStarting && item.waiting /= Nothing then
                InQueue

            else
                InSlot


{-| The cards the keyboard cursor walks, in the order the floor shows them:
bay by bay, slots, then queue, then shelf.
-}
floorOrder : Model -> List Thread
floorOrder model =
    let
        rank item =
            case placeOf item of
                InSlot ->
                    0

                InQueue ->
                    1

                Shelved ->
                    2
    in
    shownThreads model |> List.sortBy (\item -> ( Maybe.withDefault "~" item.runnerId, rank item, negate item.createdAt ))
