import firebase from "firebase/app"
import "firebase/firestore"
import initFirebase from "../auth/initFirebase"
import Router from "next/router"

initFirebase()

const db = firebase.firestore()

export type UserProjectsResponse = {
  oid: string
  uid: string
  projects: string[]
  isOwner: boolean
  isAuthenticated: boolean
  error?: Error
}

export type ProjectResponse = {
  uid: string
  oid: string
  pid: string
  isAuthenticated: boolean
  isProject: boolean
  isOwner: boolean
  error?: Error
}

export async function getTemplate(pid: string) {
  const doc = await db.collection("templates").doc(pid).get()

  if (doc.exists) {
    return doc.data()
  } else {
    throw Error("Missing template! ID:" + pid)
  }
}

export function getProject(pid: string, oid: string) {
  return db.collection("users").doc(oid).collection("projects").doc(pid)
}

export function addProject(
  pid: string,
  oid: string,
  template: { [key: string]: any }
) {
  return getProject(pid, oid).set({ ...template, owner: oid })
}

export function updateProject(
  pid: string,
  oid: string,
  changes: { [key: string]: any }
) {
  return getProject(pid, oid).update(changes)
}

export async function createProject(
  pid: string,
  uid: string,
  templateId = "toggle"
) {
  const template = await db.collection("templates").doc(templateId).get()
  await addProject(pid, uid, template.data())
}

export async function updateProjectJsx(
  pid: string,
  oid: string,
  uid: string,
  code: string
) {
  // must be owner
  if (uid === oid) {
    return updateProject(pid, oid, {
      jsx: JSON.stringify(code),
    })
  }
}

export async function updateProjectCode(
  pid: string,
  oid: string,
  uid: string,
  code: string
) {
  // must be owner
  if (uid === oid) {
    return updateProject(pid, oid, {
      code: JSON.stringify(code),
    })
  }
}

export function subscribeToDocSnapshot(
  pid: string,
  oid: string,
  callback: (
    doc: firebase.firestore.DocumentSnapshot<firebase.firestore.DocumentData>
  ) => void
) {
  let unsub: any

  getProject(pid, oid)
    .get()
    .then((doc) => {
      if (!doc.exists) {
        console.log("no project!")
      }

      unsub = db
        .collection("users")
        .doc(oid)
        .collection("projects")
        .doc(pid)
        .onSnapshot((doc) => {
          if (!doc.exists) {
            return
          }
          callback(doc)
        })
    })

  return () => unsub && unsub()
}

export async function forkProject(pid: string, oid: string, uid: string) {
  const project = await getProject(pid, oid).get()
  const code = project.data().code
  const doc = db.collection("users").doc(uid).collection("projects").doc(pid)
  const initial = await doc.get()

  if (initial.exists) {
    await doc.update({
      code,
    })
  } else {
    await doc.set({
      code,
      owner: uid,
    })
  }

  Router.push(`/${uid}/${pid}`)
}

export async function getProjectInfo(pid: string, oid: string, uid: string) {
  const project = await getProject(pid, oid).get()

  return {
    isProject: project.exists,
    isOwner: oid === uid,
  }
}

export async function getUserProjects(uid: string) {
  const snapshot = await db
    .collection("users")
    .doc(uid)
    .collection("projects")
    .get()

  const projects = snapshot.docs.map((doc) => doc.id)

  return {
    projects,
  }
}
