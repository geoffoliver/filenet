@AGENTS.md

# Filenet

This is a self-hosted Javascript (Bun) application with a NextJS frontend that lets users share files and chat with friends. The way it works is that users maintain a list of friends they can share files with and chat with. There is no central server, users connect to eachother directly. All communication - chat, searches, file transfers - happens over encrypted websockets (provided by Bun).


## Encryption

The application uses public key cryptography to encrypt messages. The application should its public key accessible to any other nodes that request it, even if the node requesting the key is not known to the node that contains the key.


## Friends

A friend consists of, at minimum, a name and a domain or IP address. When a user adds a friend, the friend will be in a "pending" state until the new "Friend" accepts the request (or if they have configured their application to auto-accept friend requests). A user can also add a friend and skip the confirmation step by entering a password that the new "Friend" provides to them.


## Indexing

The application should index files and store details about the files in its database. The "details" include, but are not limited to: filename, file size, SHA hash, meta data (i.e. artist, album, track number, duration, bitrate, chapters, etc. -- whatever we can get), and duration. Basically, any info about the file that would be useful when searching for files. The application should periodically scan for new/changed files and update the index.


## Searching

A user should be able to search for shared files across the entire network. This means if I search for a file, it should search all of my friends files, their friends files, their friends files, and so on. Users should be able to search by filename, file type, and metadata. Every node in the network that is able to find files that match the search criteria should deliver the results directly back to the requesting user.


### Downloading

When a user downloads a file, the application works like Bittorrent, and downloads the file in chunks from as many users as possible. A file is considered to be "the same" if the SHA hashes match. Downloads will be resumable.


## Networking

The application should be capable of getting through a NAT without the users having to open up ports on their router. However, if getting through a NAT automatically is not possible, the application should provide generic instructions on how to open the port.


## Chat

The application should support group and one-on-one chats. One-on-one chat logs are stored indefinitely or until the user instructs the application to delete them, and group chat logs are stored until the user leaves the group chat.

## Configuration Options

The application should let users configure certain aspects:
- Profile details
  - Name
	- Email
	- Picture
	- Bio
	- Links
- The folder/folders they want to share
- The folder where they want to download files
- Scripts (JS/TS) to execute once a download completes
- The port the application should listen on
- Whehter to auto accept friend requests:
  - From people they don't know
	- From friends of friends
- How many "degrees of separation" to share files:
	- Friends
	- Friends of friends
	- Everyone
- The abilty to force a rescan of shared files


## UI

The application is a Single Page App, with a sticky navbar at the top, and the main content below the navbar. The navbar will contain links for the following sections: Home, Search, Chat, Friends, Transfers, Settings; and a search field, that when used (i.e., when a user hits "enter" or clicks a "search" button, it switches the user to the "Search" section and kicks off a search).

### Setup

When the user first launches the app, they should be presented with a setup interface that essentially walks them through everything they can do in the "Configuration Options" with some sensible defaults in place.


### Home

This is essentially a "dashboard" for the application. For example, it should display stats on files downloaded; statc on files shared, bytes/MB/GB/whatever downloaded, bytes/MB/GB/whatever uploaded; size of network; friends online; current transfers overview; etc..


### Search

A simple search form with an text input and a dropdown that lets the user choose the type of files they want to search for (i.e. "All", "Audio", "Video", "Ebook", "Documents", etc., etc.). Results should display below the search field, and allow a user to view details about the file (size, metadata, how many users have the file, etc.) and download the file.


### Chat

A split-pane view like Slack, Discord, or any other chat app that everyone is familar with. The left pane lists the users friends that are onilne, followed by any group chats/chat rooms the user is a member of. The right pane displays messages from the chat session that is selected in the left pane, with the newest message on the bottom. Users can create new group chats/chat rooms, and rooms should be shared across the entire network and accessible to any user of the network. Chat messages should persist for the lifetime of the page.


### Friends

A list of friends that shows their name, profile picture (if available), how long you've been friends, total count of shared files, total files downloaded from user (count and size), total file uploaded to user (count and size). This page should also include an "Add Friend" button that shows a form that lets a user add a new friend by inputting a name, domain or IP address, and an optional password for the friend. Finally, for each friend in the list there should be options to remove them from your friend list.


### Transfers

A split-pane view. The top pane displays ongoing uploads, and transfers disappear from the list automatically. The bottom pane shows ongoing downloads, and by default, transfers must be removed from this list manually. If a download is in progress, the user should have the ability to pause or cancel the download. If a user pauses a file, the user should have options to resume the download or cancel the download. If the user cancels the download, whatever has been downloaded should be deleted. Both downloads and uploads should include the filename, a progress bar, remaining time, transfer speed, total bytes/MB/GB/whatever transferred. Downloads will also include the number of sources (how many users you're downloading the file from). Once a download has completed, it can't be canceled - a user must remove the file from the list and manually remove the file from the filesystem. This is because a script might have moved the file, and the application might not have access to it.


## Scripting

The application will let users write scripts that can run after a download has completed to take an action on the file, such as moving it into a different directory, combining it with other files into a compressed archive, redirecting it to another location, or performing post processing. The user writes scripts in their text editor of choice and tells the application which scripts to run, and which order to run them from the "Settings" interface. The default export of a script should be a function that accepts a single argument: `{ file: BunFile; stats: TransferStats; }`, where `BunFile` is a literal `BunFile` (provided by the Bun framework) and `TransferStats` are an object containing stats about the transfer (download time, bytes transferred, max sources, etc.), and is a reference to the file that was downloaded.


## Tech Stack

- Runtime: Bun
- Framework: NextJS 16
- Styling: Tailwind v4
- Database: Prisma/SQLite
