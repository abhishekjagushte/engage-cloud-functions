import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
// import * as mkdirp from "mkdirp";
// import * as sharp from "sharp";
const spawn = require('child-process-promise').spawn;

//import * as Storage from '@google-cloud/storage'
admin.initializeApp();

// Start writing Firebase Functions
// https://firebase.google.com/docs/functions/typescript

const SEND_FR = "1";
const ACCEPTED_FR = "2";
const MESSAGE_RC = "3";
const ADDED_IN_GROUP = "4";
const MESSAGE_RC_M2M = "5";
const REMINDER_COMPLETED = "6";

/*
Types of notification to be sent
 1 = Sent you friend request
 2 = Accepted friend request
 3 = Added in group
 4 = reminder completed

 */

/*
 Types of notifications in users collection
 3 = added in group

 */

//Commands
/*
    to check errors = npm run-script lint
    to convert to js = npm run-script build
    to run in emulator = firebase serve --only functions
    to deploy = firebase deploy
*/

const db = admin.firestore();
//const gcs = Storage();

export const onUserUpdated = functions.firestore
  .document("users/{username}")
  .onUpdate((change) => {
    const previousDoc = change.before.data();
    const updatedDoc = change.after.data();

    const namePrev = previousDoc.name;
    const nameNew = updatedDoc.name;

    if (namePrev !== nameNew) {
      console.log("Name updated");

      // Handle Name Change Event
    }

    return null;
  });

export const handleFriendRequests = functions.firestore
  .document("connection-requests/{conn_req}")
  .onCreate(async (snap) => {
    const req = snap.data();
    const promises = [];

    const batch = db.batch();

    if (req.type === 1) {
      batch.create(
        db
          .collection("users")
          .doc(req.senderID)
          .collection("users-requested")
          .doc(req.receiverID),
        {
          username: req.receiverID,
          req_timeStamp: req.timeStamp,
        }
      );

      batch.create(
        db
          .collection("users")
          .doc(req.receiverID)
          .collection("users-pending")
          .doc(req.senderID),
        {
          username: req.senderID,
          req_timeStamp: req.timeStamp,
        }
      );

      promises.push(batch.commit());

      const recieverData = await db
        .collection("users")
        .doc(req.receiverID)
        .get();

      const payload = {
        data: {
          type: SEND_FR,
          name: req.senderName,
          username: req.senderID,
          timeStamp: req.timeStamp,
        },
      };

      const options = {
        priority: "high",
        timeToLive: 2419200,
      };

      promises.push(
        admin
          .messaging()
          .sendToDevice(
            recieverData.data().notificationChannelID,
            payload,
            options
          )
      );
    } else if (req.type === 2) {
      //ACCEPT

      //Sender Side
      batch.create(
        db
          .collection("users")
          .doc(req.senderID)
          .collection("users-contacts")
          .doc(req.receiverID),
        {
          username: req.receiverID,
          establish_timeStamp: req.timeStamp,
        }
      );

      batch.delete(
        db
          .collection("users")
          .doc(req.senderID)
          .collection("users-pending")
          .doc(req.receiverID)
      );

      //Reciever Side
      batch.create(
        db
          .collection("users")
          .doc(req.receiverID)
          .collection("users-contacts")
          .doc(req.senderID),
        {
          username: req.senderID,
          establish_timeStamp: req.timeStamp,
        }
      );

      batch.delete(
        db
          .collection("users")
          .doc(req.receiverID)
          .collection("users-requested")
          .doc(req.senderID)
      );

      promises.push(batch.commit());

      const recieverData1 = await db
        .collection("users")
        .doc(req.receiverID)
        .get();

      const payload = {
        data: {
          type: ACCEPTED_FR,
          name: req.senderName,
          username: req.senderID,
          timeStamp: req.timeStamp,
        },
      };

      const options = {
        priority: "high",
        timeToLive: 2419200, //max limit 28 days
      };

      promises.push(
        admin
          .messaging()
          .sendToDevice(
            recieverData1.data().notificationChannelID,
            payload,
            options
          )
      );
    }

    return Promise.all(promises).then((responses) => {
      const fcmResponse = responses[1];
      const result = fcmResponse.results;
      if (result[0].error) {
        console.log(result[0].error.code);
      } else {
        console.log("No error encountered");
      }
    });
  });

export const sendMessage121 = functions.firestore
  .document("messages121/{message}")
  .onCreate(async (snap) => {
    const msg = snap.data();

    const receiverProfile = (
      await db.collection("users").doc(msg.receiverID).get()
    ).data();
    const notificationChannelID = receiverProfile.notificationChannelID;

    const options = {
      priority: "high",
      timeToLive: 2419200, //max limit 28 days
    };

    const payload = {
      data: {
        type: MESSAGE_RC,
        data: msg.data,
        latitude: msg.latitude === null ? "" : msg.latitude,
        longitude: msg.longitude === null ? "" : msg.longitude,
        messageID: msg.messageID,
        mime_type: msg.mime_type,
        receiverID: msg.receiverID,
        reply_toID: msg.reply_toID === null ? "" : msg.reply_toID,
        senderID: msg.senderID,
        server_url: msg.server_url === null ? "" : msg.server_url,
        thumb_nail: msg.thumb_nail === null ? "" : msg.thumb_nail,
        timeStamp: String(msg.timeStamp.toMillis()),
      },
    };

    //TODO handle expired notificationChannelIDs

    return admin
      .messaging()
      .sendToDevice(notificationChannelID, payload, options);
  });

export const sendMessageM2M = functions.firestore
  .document("groups/{conversation}/chats/{message}")
  .onCreate(async (snap, context) => {
    const msg = snap.data();
    const conversationID = context.params.conversation;

    const members = (await db.doc("groups/" + conversationID).get()).data()
      .participants;
    const nIDs = [];

    for (const member of members) {
      if (member.username !== msg.senderID)
        nIDs.push(member.notificationChannelID);
    }

    const options = {
      priority: "high",
      timeToLive: 2419200, //max limit 28 days
    };

    const payload = {
      data: {
        type: MESSAGE_RC_M2M,
        conversationID: conversationID,
        data: msg.data,
        latitude: msg.latitude === null ? "" : msg.latitude,
        longitude: msg.longitude === null ? "" : msg.longitude,
        messageID: msg.messageID,
        mime_type: msg.mime_type,
        receiverID: msg.receiverID === null ? "" : msg.receiverID,
        reply_toID: msg.reply_toID === null ? "" : msg.reply_toID,
        senderID: msg.senderID,
        server_url: msg.server_url === null ? "" : msg.server_url,
        thumb_nail: msg.thumb_nail === null ? "" : msg.thumb_nail,
        timeStamp: String(msg.timeStamp.toMillis()),
      },
    };

    //TODO handle expired notificationChannelIDs

    return admin.messaging().sendToDevice(nIDs, payload, options);
  });

export const createGroup = functions.https.onCall(async (data, context) => {
  const name = data.name;
  const participants = data.participants;
  const conversationID = data.conversationID;
  const creator = data.creator;

  const batch = db.batch();
  const promises = [];

  const participantInfo = [];
  const nIDs = [];

  //payload for fcm
  const payload = {
    data: {
      type: ADDED_IN_GROUP,
      name: name,
      conversationID: conversationID,
      //The participants will be fetched by the client itself
    },
  };

  for (const participant of participants) {
    //above variable participant is the username of the participant in the group
    //1. Add the group in the user profile - conversationID - mostly array union
    //2. create the document in groups collection
    //3. The collection will also cantain the notificationIds
    //4. Set the notifications mechanism planned
    const profile = (
      await db.collection("users").doc(participant).get()
    ).data();

    if (
      !(
        await db
          .doc("users/" + participant + "/conversationsM2M/conversationsM2M")
          .get()
      ).exists
    )
      await db
        .doc("users/" + participant + "/conversationsM2M/conversationsM2M")
        .set({
          conversationsM2M: [],
        });

    batch.update(
      db.doc("users/" + participant + "/conversationsM2M/conversationsM2M"),
      {
        conversationsM2M: admin.firestore.FieldValue.arrayUnion(conversationID),
      }
    );
    //to be used while initialting the group
    participantInfo.push({
      username: participant,
      notificationChannelID: profile.notificationChannelID,
    });

    //sets the notification collection
    batch.set(
      db.collection("users/" + participant + "/notifications").doc(),
      payload
    );

    if (participant !== creator) nIDs.push(profile.notificationChannelID);
  }

  batch.set(
    db.collection("groups").doc(conversationID),
    getGroupObject(participantInfo, name, creator)
  );

  try {
    promises.push(batch.commit());
    promises.push(sendFCM(nIDs, payload));

    return Promise.all(promises).then(() => {
      return {
        status: "success",
      };
    });
  } catch (err) {
    console.log("Error updating batch");

    return {
      status: "failure",
    };
  }
});

function getGroupObject(participantsInfo, name, creator) {
  return {
    name: name,
    participants: participantsInfo,
    creator: creator,
    createdTimeStamp: admin.firestore.FieldValue.serverTimestamp(),
  };
}

function sendFCM(
  notificationChannelIDs,
  payload
): Promise<admin.messaging.MessagingDevicesResponse> {
  const options = {
    priority: "high",
    timeToLive: 2419200, //max limit 28 days
  };

  return admin
    .messaging()
    .sendToDevice(notificationChannelIDs, payload, options);
}

export const markReminderDone = functions.https.onCall(
  async (data, context) => {
    const receiverID = data.receiverID;
    const eventID = data.eventID;
    const senderID = data.senderID;

    const nID = (await db.collection("users").doc(senderID).get()).data()
      .notificationChannelID;

    await db
      .collection("users")
      .doc(receiverID)
      .collection("events121")
      .doc(eventID)
      .update({
        status: REMINDER_COMPLETED,
      });

    const payload = {
      data : {
        type: REMINDER_COMPLETED,
        eventID: eventID,
        receiverID: receiverID,
      }
    };

    return sendFCM(nID, payload);
  }
);

export const sync = functions.https.onCall(async (input, context) => {
  const uid = context.auth.uid;
  let syncTimeStamp;
  const response = {
    chats: [],
    events: [],
  };

  if (uid !== null) {
    console.log(uid);
    const res = (await db.collection("users").where("id", "==", uid).get())
      .docs;

    console.log(res[0]);

    const info = res[0].data();

    const username = info.username;
    try {
      syncTimeStamp = info.syncTimeStamp;
      console.log("Timestamp = " + syncTimeStamp);
    } catch (err) {
      console.log("sync timestamp not defined");
    }

    try {
      //Only one document conversationsm2m
      const m2m = (
        await db.collection("users/" + username + "/conversationsM2M").get()
      ).docs[0].data();

      console.log(m2m);

      for (const con of m2m.conversationsM2M) {
        const msgs = await db
          .collection("groups/" + con + "/chats")
          .where("timeStamp", ">=", syncTimeStamp)
          .get();

        for (const msg of msgs.docs) {
          if (msg.data().senderID !== username) response.chats.push(msg);
        }

        const events = await db
          .collection("groups/" + con + "/events")
          .where("timeStamp", ">=", syncTimeStamp)
          .get();

        for (const event of events.docs) {
          if (event.data().senderID !== username) response.events.push(event);
        }
      }
    } catch (err) {
      //If user has no m2m conversations
      console.log("No M2M conversations");
    }

    const c121 = (
      await db
        .collection("messages121")
        .where("receiverID", "==", username)
        .where("timeStamp", ">=", syncTimeStamp)
        .get()
    ).docs;

    c121.forEach(function (msg) {
      response.chats.push(msg);
    });

    //TODO - Add for 121 events

    return db
      .collection("users")
      .doc(username)
      .update("syncTimeStamp", admin.firestore.FieldValue.serverTimestamp())
      .then((result) => {
        return {
          status: "success",
          data: response,
        };
      });
  } else {
    return {
      status: "failure",
    };
  }
});


export const generateDownloadThumbnail = functions.storage
  .object()
  .onFinalize(async (object) => {
    const fileBucket = object.bucket; // The Storage bucket that contains the file.
    const filePath = object.name; // File path in the bucket.
    const contentType = object.contentType; // File content type.
    // [END eventAttributes]
  
    // [START stopConditions]
    // Exit if this is triggered on a file that is not an image.
    if (!contentType.startsWith('image/')) {
      console.log("This is not an image")
      return 
    }
  
    // Get the file name.
    const fileName = path.basename(filePath);
    // Exit if the image is already a thumbnail.
    if (fileName.startsWith('thumb_')) {
      console.log('Already a Thumbnail.');
      return 
    }
    // [END stopConditions]
  
    // [START thumbnailGeneration]
    // Download file from bucket.
    const bucket = admin.storage().bucket(fileBucket);
    const tempFilePath = path.join(os.tmpdir(), fileName);
    const metadata = {
      contentType: contentType,
    };
    await bucket.file(filePath).download({destination: tempFilePath});
    console.log('Image downloaded locally to', tempFilePath);
    // Generate a thumbnail using ImageMagick.
    await spawn('convert', [tempFilePath, '-thumbnail', '200x200>', tempFilePath]);
    console.log('Thumbnail created at', tempFilePath);
    // We add a 'thumb_' prefix to thumbnails file name. That's where we'll upload the thumbnail.
    const thumbFileName = `thumb_${fileName}`;
    const thumbFilePath = path.join(path.dirname(filePath), thumbFileName);
    // Uploading the thumbnail.
    await bucket.upload(tempFilePath, {
      destination: thumbFilePath,
      metadata: metadata,
    });
    // Once the thumbnail has been uploaded delete the local file to free up disk space.
    fs.unlinkSync(tempFilePath);
    return 
    // [END thumbnailGeneration]
  });



/*const fileBucket = object.bucket;
    const filePath = object.name;
    const contentType = object.contentType; // This is the image MIME type
    const metageneration = object.metageneration;

    const fileDir = path.dirname(filePath);
    const fileName = path.basename(filePath);
    const thumbFilePath = path.normalize(
      path.join(fileDir, `${THUMB_PREFIX}${fileName}`)
    );

    const tempLocalFile = path.join(os.tmpdir(), filePath);
    const tempLocalDir = path.dirname(tempLocalFile);
    const tempLocalThumbFile = path.join(os.tmpdir(), thumbFilePath);

    console.log("filepath = "+ filePath);
    console.log("fileDir = "+ fileDir );
    console.log("filename = "+ fileName);
    console.log("contentType = "+ contentType);
    console.log("thumbFilePath = "+ thumbFilePath);
    console.log("tempLocalDir = "+tempLocalDir);
    console.log("tempLocalFile = "+tempLocalFile);
    console.log("tempLocalThumbFile = "+ tempLocalThumbFile)


    // Exit if this is triggered on a file that is not an image.
    if (!contentType.startsWith("image/")) {
      console.log("This is not an image.");
      return;
    }

    // Exit if the image is already a thumbnail.
    if (fileName.startsWith(THUMB_PREFIX)) {
      console.log("Already a Thumbnail.");
      return;
    }

    // Cloud Storage files.
    const bucket = admin.storage().bucket(object.bucket);
    const file = bucket.file(filePath);
    //const thumbFile = bucket.file(thumbFilePath);
    const metadata = {
      contentType: contentType,
      // To enable Client-side caching you can set the Cache-Control headers here. Uncomment below.
      // 'Cache-Control': 'public,max-age=3600',
    };

    // Create the temp directory where the storage file will be downloaded.
    await mkdirp(tempLocalDir);
    // Download file from bucket.
    await file.download({ destination: tempLocalFile });
    console.log("The file has been downloaded to", tempLocalFile);

    sharp(tempLocalFile)
      .blur(50)
      .toFile(tempLocalThumbFile)
      .catch((err) => console.log(err));

    await bucket.upload(tempLocalThumbFile, {
      destination: thumbFilePath,
      metadata: metadata,
    });
    console.log("Thumbnail uploaded to Storage at", thumbFilePath);

    fs.unlinkSync(tempLocalFile);
    fs.unlinkSync(tempLocalThumbFile);

    console.log("Operation Performed Successfully");
    return;*/



// export const timestampTest = functions.https.onCall(async (request)=> {

//     const response = {
//         list: []
//     }

//     const time1 = (await db.collection("test").get()).docs[0].data().time

//     console.log("Test"+time1);

//     const res = (await db.collection("time").where("time", ">=", time1).get()).docs

//     for(const d of res)
//         response.list.push(d)

//     return response
// })

/*


    export const createNewChat121 = functions.https.onCall(async (data, context) => {

        const id = data.conversationID

        // //This will always be false as while logging in all the conversations will be fetched already
        // if((await db.collection("conversations121").doc(id).get()).exists){
        //     status = false
        //     id = db.collection("conversations121").doc().id
        // }

        const batch = db.batch()
        const myProfile = await db.collection("users").doc(data.myID).get()
        const otherProfile = await db.collection("users").doc(data.otherID).get()


        //This part adds a hashmap to the conversations121 array containing the username of the
        //other person
        batch.update(db.collection("users").doc(data.myID), {
            conversations121: admin.firestore.FieldValue.arrayUnion({
                username: data.otherID,
                conversationID: id
            })
        })

        batch.update(db.collection("users").doc(data.otherID), {
            conversations121: admin.firestore.FieldValue.arrayUnion({
                username: data.myID,
                conversationID: id
            })
        })

        await batch.commit()

        //saves the notification channel id of the users
        return db.collection("conversations121").doc(id).set(
            {
                conversationID: id,

                participants :  {
                    [data.myID] : myProfile.get("notificationChannelID"),
                    [data.otherID]: otherProfile.get("notificationChannelID")
                },

                startTimeStamp: admin.firestore.FieldValue.serverTimestamp()
            }
        ).then(() => {
            console.log("new chat created")

            return {
                status: "yes",
                conversationID: id }
            // if(status){
            //         return {
            //             status: "yes",
            //             conversationID: id }
            //     }
            // else{
            //     return {
            //         status: "no",
            //         conversationID: id }
            // }
        })

    })


    export const testDateSorting = functions.https.onRequest((request, response) => {

        admin.firestore().collection("users").orderBy('joinTimeStamp').get()
            .then(snapshots => {
                const data=[]

                for(const snap of snapshots.docs){
                    data.push(snap)
                }
                response.send(data)

            }).catch(error => {
                    console.log(error)
                    response.status(500).send(error)
            })
    })


    async function create121ChatChannel(user1, user2, conversationID){

        const batch = db.batch()
        const myProfile = await db.collection("users").doc(user1).get()
        const otherProfile = await db.collection("users").doc(user2).get()


        //This part adds a hashmap to the conversations121 array containing the username of the
        //other person
        if((await db.collection("users").doc(user1).collection("conversations121").doc("conversations121").get()).exists){
            batch.update(db.collection("users").doc(user1).collection("conversations121").doc("conversations121"), {
                conversations121: admin.firestore.FieldValue.arrayUnion({
                    username: user2,
                    conversationID: conversationID
                })
            })

            batch.update(db.collection("users").doc(user2).collection("conversations121").doc("conversations121"), {
                conversations121: admin.firestore.FieldValue.arrayUnion({
                    username: user1,
                    conversationID: conversationID
                })
            })
        }
        else{
            batch.set(db.collection("users").doc(user1).collection("conversations121").doc("conversations121"), {
                conversations121: [{
                    username: user2,
                    conversationID: conversationID
                }]
            })

            batch.set(db.collection("users").doc(user2).collection("conversations121").doc("conversations121"), {
                conversations121: [{
                    username: user1,
                    conversationID: conversationID
                }]
            })
        }


        await batch.commit()

        //saves the notification channel id of the users
        await db.collection("conversations121").doc(conversationID).set(
            {
                conversationID: conversationID,

                participants :  {
                    [user1] : myProfile.get("notificationChannelID"),
                    [user2]: otherProfile.get("notificationChannelID")
                },

                startTimeStamp: admin.firestore.FieldValue.serverTimestamp()
            }
        )

    }




        export const sendMessage121 = functions.firestore
        .document("conversations121/{conversation}/chats/{message}")
        .onCreate(async snap => {

            const msg = snap.data()
            const conID = msg.conversationID

            let conDoc = await db.collection("conversations121").doc(conID).get()

            if(!conDoc.exists){
                await create121ChatChannel(msg.senderID, msg.receiverID, msg.conversationID)
                conDoc = await db.collection("conversations121").doc(conID).get()
            }

            const conv = conDoc.data()
            const notificationChannelID = conv.participants[msg.receiverID]

            const options = {
                priority: 'high',
                timeToLive: 2419200 //max limit 28 days
            }

            const payload = {
                data: {
                    type : "3",
                    conversationID: msg.conversationID,
                    data: msg.data,
                    latitude: msg.latitude === null?"":msg.latitude,
                    longitude: msg.longitude === null?"":msg.longitude,
                    messageID: msg.messageID,
                    mime_type: msg.mime_type,
                    receiverID: msg.receiverID,
                    reply_toID: msg.reply_toID === null?"":msg.reply_toID,
                    senderID: msg.senderID,
                    server_url: msg.server_url === null?"":msg.server_url,
                    thumb_nail: msg.thumb_nail=== null?"":msg.thumb_nail,
                    timeStamp: String(msg.timeStamp.toMillis())
                }
            }

            //TODO handle expired notificationChannelIDs

            return admin.messaging()
                .sendToDevice(notificationChannelID, payload, options)

        })




        export const createNewChat121 = functions.https.onCall(async (data, context) => {

        const myProfile = await db.collection("users").doc(data.myID).get()
        const cons = myProfile.get("conversations121")

        //This part is for checking if conversation already exits
        //But this isn't required as if conversation already exists then
        //it will be downloaded while loggin in
        for(const con of cons){
            console.log(typeof con)
            console.log(con)
            if(con.username === data.otherID)
            {
                console.log("returned from profile "+con)
                const conID = con.conversationID
                return { conversationID: conID }
            }
        }

        const id = db.collection("conversations121").doc().id
        const batch = db.batch()
        const otherProfile = await db.collection("users").doc(data.otherID).get()


        //This part adds a hashmap to the conversations121 array containing the username of the
        //other person
        batch.update(db.collection("users").doc(data.myID), {
            conversations121: admin.firestore.FieldValue.arrayUnion({
                username: data.otherID,
                conversationID: id
            })
        })

        batch.update(db.collection("users").doc(data.otherID), {
            conversations121: admin.firestore.FieldValue.arrayUnion({
                username: data.myID,
                conversationID: id
            })
        })

        await batch.commit()

        //saves the notification channel id of the users
        return db.collection("conversations121").doc(id).set(
            {
                conversationID: id,

                participants :  {
                    [data.myID] : myProfile.get("notificationChannelID"),
                    [data.otherID]: otherProfile.get("notificationChannelID")
                },

                startTimeStamp: admin.firestore.FieldValue.serverTimestamp()
            }
        ).then(() => {
            console.log("new chat created")

            return { conversationID: id }
        })

    })
        */

//type 1
//REQUEST

// batch.update(db.collection("users").doc(req.senderID),
//     {
//         requested : admin.firestore.FieldValue.arrayUnion(req.receiverID)
//     }
// )

// batch.update(db.collection("users").doc(req.receiverID),
//     {
//         pending : admin.firestore.FieldValue.arrayUnion(req.senderID)
//     }
// )

//type 2
/*
            batch.update(db.collection("users").doc(req.senderID),
                {
                    connections : admin.firestore.FieldValue.arrayUnion(req.receiverID),
                    pending : admin.firestore.FieldValue.arrayRemove(req.receiverID)
                }
            )

            batch.update(db.collection("users").doc(req.receiverID),
                {
                    connections : admin.firestore.FieldValue.arrayUnion(req.senderID),
                    requested : admin.firestore.FieldValue.arrayRemove(req.senderID)
                }
            ) */

/*
    promises.push(db.collection("users").doc(req.senderID)
    .update({
            connections : admin.firestore.FieldValue.arrayUnion(req.receiverID),
            pending : admin.firestore.FieldValue.arrayRemove(req.receiverID)
        }
    ))

    promises.push(db.collection("users").doc(req.receiverID)
        .update({
                pending : admin.firestore.FieldValue.arrayUnion(req.senderID)
            }
        )
    )*/

/*
            promises.push(db.collection("users").doc(req.senderID)
                .update({
                        requested : admin.firestore.FieldValue.arrayUnion(req.receiverID)
                    }
                ))

                promises.push(db.collection("users").doc(req.receiverID)
                .update({
                        pending : admin.firestore.FieldValue.arrayUnion(req.senderID)
                    }
                )
            )*/

/*
        function handleFriendRequests(previousDoc, updatedDoc){

            const pendingPrev = previousDoc.pending
            const pendingNew = updatedDoc.pending
            const connectionsPrev = previousDoc.connections
            const connectionsNew = updatedDoc.connections

            if(pendingPrev.length !== pendingNew.length){
                //Handle pending updated list
                //The event is if someone requests this user for connection

                if(pendingPrev.length < pendingNew.length){

                    const requester = pendingNew[pendingNew.length-1]
                    console.log(requester)

                    //sending a notification to user about getting a friend request
                    db.doc("users/"+requester).get()
                        .then(userSnapshot => {

                            //Accessing this document of requester to get the name of requester
                            const Name = userSnapshot.data().name
                            const id = userSnapshot.data().id
                            const bio = userSnapshot.data().bio

                            const mID = updatedDoc.notificationChannelID

                            const payload = {
                                data: {
                                    type: "1",
                                    name: Name,
                                    username: requester,
                                    id: id,
                                    bio: bio
                                }
                            }

                            //console.log(payload)

                            //notifying the recipent of friend request
                            return admin.messaging().sendToDevice(mID,payload).catch(
                                error =>{
                                    console.error("FCM failed",error)
                                }
                            )

                        }).catch(error =>{
                            console.log("error")
                        })

                }
            }


            if(connectionsPrev.length!==connectionsNew.length){
                //If this user accepts the friend request
                //There will be two changes the requester will be deleted from pending and added to connections

                //This part notifies the requestor his request is accpeted

                if(connectionsNew.length > connectionsPrev.length)
                {
                    const newconn = connectionsNew[connectionsNew.length - 1]
                    console.log("Inside "+ updatedDoc.username + " new conn: "+ newconn)

                    db.doc("users/"+newconn).get()
                        .then(userSnapshot => {

                            const mID = userSnapshot.data().notificationChannelID

                            const payload = {
                                data: {
                                    type: "2",
                                    name: updatedDoc.name,
                                    username: updatedDoc.username
                                }
                            }

                            console.log(payload)

                            admin.messaging().sendToDevice(mID,payload).catch(err =>{
                                console.log("FCM Failed"+err)
                            })

                        }).catch(err => {
                            console.log("FCM failed")
                        })
                }
            }
        }

        */

// export const helloWorld = functions.https.onRequest((request, response) => {
//  response.send("Hello from Firebase!");
// });
