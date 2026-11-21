'use strict';

//
//  Who owns a view, and what state its form is in.
//
//  - view -> its form (ViewController.addView())
//  - form -> its menu (MenuModule.addViewController(), which the prep*()
//    helpers, standardMCIReadyHandler() and promptForInput() all use)
//  - per form: inactive (deactivate(), or cover()), covered (cover(), with
//    its background draw suspend token) and destroyed (destroy(): terminal)
//
//  Kept here, in module-private weak collections, rather than as properties,
//  so no name is taken from a mod's View, ViewController or MenuModule
//  subclass, and so view.js can read it without requiring
//  view_controller.js (which requires view.js).
//
//  A view with no form, or a form with no menu (a theme's temporary prompt
//  form, a mod's bare view), is owner-less: see View.suspendBackgroundDraw().
//

const viewForms = new WeakMap();
const formMenus = new WeakMap();
const inactiveForms = new WeakSet();
const coverTokens = new WeakMap();
const destroyedForms = new WeakSet();

function setViewForm(view, form) {
    if (view && form) {
        viewForms.set(view, form);
    }
}

function getViewForm(view) {
    return viewForms.get(view) || null;
}

function setFormMenu(form, menu) {
    if (form && menu) {
        formMenus.set(form, menu);
    }
}

function getFormMenu(form) {
    return (form && formMenus.get(form)) || null;
}

function setFormInactive(form, inactive) {
    if (inactive) {
        inactiveForms.add(form);
    } else {
        inactiveForms.delete(form);
    }
}

function isFormInactive(form) {
    return inactiveForms.has(form);
}

function setFormCoverToken(form, token) {
    if (token) {
        coverTokens.set(form, token);
    } else {
        coverTokens.delete(form);
    }
}

function getFormCoverToken(form) {
    return coverTokens.get(form) || null;
}

function markFormDestroyed(form) {
    destroyedForms.add(form);
}

function isFormDestroyed(form) {
    return destroyedForms.has(form);
}

//  True while |form| takes no keys on purpose: deactivated, or covered
function isFormPaused(form) {
    return !!form && (inactiveForms.has(form) || coverTokens.has(form));
}

module.exports = {
    setViewForm,
    getViewForm,
    setFormMenu,
    getFormMenu,
    setFormInactive,
    isFormInactive,
    setFormCoverToken,
    getFormCoverToken,
    markFormDestroyed,
    isFormDestroyed,
    isFormPaused,
};
