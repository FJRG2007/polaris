use std::sync::Arc;

use input_classifier::{HeuristicClassifier, InputClassifier};
#[cfg(feature = "nld_classifier_v3")]
use input_classifier::{OnnxClassifier, OnnxModel};
use ptermui::{Entity, ModelContext, SingletonEntity};

pub struct InputClassifierModel {
    pub classifier: Arc<dyn InputClassifier>,
}

impl InputClassifierModel {
    pub fn new(_ctx: &mut ModelContext<Self>) -> Self {
        #[cfg(feature = "nld_classifier_v3")]
        {
            match OnnxClassifier::new(OnnxModel::BertTinyV3) {
                Ok(classifier) => {
                    log::info!("Loaded onnx classifier bert_tiny_v3.onnx");
                    return Self {
                        classifier: Arc::new(classifier),
                    };
                }
                Err(e) => log::warn!("Failed to load onnx classifier bert_tiny_v3.onnx: {e:#}"),
            }
        }

        Self {
            classifier: Arc::new(HeuristicClassifier),
        }
    }

    pub fn classifier(&self) -> Arc<dyn InputClassifier> {
        self.classifier.clone()
    }
}

impl Entity for InputClassifierModel {
    type Event = ();
}

impl SingletonEntity for InputClassifierModel {}
